// bridge/run.ts — the Buddy bridge, as a host-level process.
//
// It runs under systemd next to the agent-runtime gateway (`buddy-bridge.service`),
// under its OWN uid `buddy-bridge`. It binds NO port. Everything it does it
// does by dialling out, on loopback:
//
//   Zulip          ← register + long-poll GET /events, POST /messages
//   agent runtime  ← POST /v1/chat/completions through a runtime-neutral seam
//
// THE THREE THINGS THIS FILE OWNS, and it owns them because everything below is
// a constructor argument and therefore testable without a host:
//
//   1. It is the ONLY place that reads `process.env`.
//   2. It runs the two startup gates, in order and fail-closed: the profile
//      custody gate, then the runtime seam.
//   3. It decides the exit code, which is the only thing a monitor ever sees.
//
// Public operator boundary: `manual/lazurio-resident-profiles.md`.

import { join } from "node:path";
import {
  createSystemMessageBuilder,
  readAgencyProfile,
} from "./agency/system-message.ts";
import {
  BRIDGE_EXIT_CONFIG_REFUSED,
  assertProfileMountIsSafe,
} from "./identity/profile-mount.ts";
import { EventBridge, createZulipEventsApi } from "./inbound/events.ts";
import {
  CONSOLE_LOGGER,
  buddyDisplayName,
  type BridgeAsyncReplySender,
  type BridgeEventLogger,
  type BridgeReplyProvider,
} from "./inbound/message.ts";
import { writePollerState } from "./inbound/poller-state.ts";
import { SessionRotations } from "./inbound/session-rotations.ts";
import { FileReplyQueue } from "./inbound/reply-queue.ts";
import { acquireSingletonLock } from "./inbound/singleton.ts";
import { TurnBreaker } from "./inbound/turn-breaker.ts";
import { DurableWatermark } from "./inbound/watermark.ts";
import { createRuntimeReplyProvider } from "./runtime-adapter/http-client.ts";
import { withSessionRecovery } from "./runtime-adapter/session-recovery.ts";
import { readRuntimeSeam, type RuntimeEnvironment } from "./runtime-adapter/seam.ts";
import {
  getOwnUserId,
  downloadRuntimeImage,
  sendToDirectMessage,
  sendToTopic,
  zulipConfigFromEnv,
  type ZulipConfig,
} from "./outbound/zulip.ts";

/**
 * The bridge's environment contract. The AGENT_RUNTIME_* keys are ours and
 * runtime-neutral; the BUDDY_* keys are wire names this repository declares end
 * to end, so no Principal's name is ever a key name; HERMES_API_* are read as
 * legacy aliases and never written (bridge/runtime-adapter/seam.ts).
 */
export interface BridgeRuntimeEnvironment extends RuntimeEnvironment {
  AGENT_RUNTIME_URL?: string;
  AGENT_RUNTIME_KEY?: string;
  AGENT_RUNTIME_SESSION_HEADER?: string;
  AGENT_RUNTIME_MODEL?: string;
  ZULIP_SITE?: string;
  BUDDY_BOT_EMAIL?: string;
  BUDDY_BOT_API_KEY?: string;
  BUDDY_NAME?: string;
  BUDDY_BRIDGE_QUEUE_DIR?: string;
  BUDDY_TURNS_PER_HOUR?: string;
  /**
   * The Principal's own `<login>-buddy` profile checkout. The bridge reads
   * CONSTITUTION.md and MANDATES.md out of it and puts them in front of every
   * turn (K3). Unset is a REFUSAL, not a default — see identity/profile-mount.ts.
   */
  BUDDY_PROFILE_DIR?: string;
}

export function createZulipReplySender(
  config: ZulipConfig,
): BridgeAsyncReplySender {
  return async (input, content) => {
    if (input.replyTarget.kind === "stream") {
      const { streamId, topic } = input.replyTarget;
      await sendToTopic(config, streamId, topic, content);
      return;
    }
    if (input.replyTarget.recipientEmails.length === 0) {
      throw new Error("Zulip direct-message reply target is incomplete");
    }
    await sendToDirectMessage(config, input.replyTarget.recipientEmails, content);
  };
}

/**
 * The reply provider, wired to the resolved profile directory.
 *
 * `profileDir` is the RESOLVED path from the custody gate, never the declared
 * string: passing the declared string here would mean the gate judged one
 * directory and the reader opened another.
 */
export function configuredReplyProvider(
  env: BridgeRuntimeEnvironment,
  profileDir: string,
  logger: BridgeEventLogger = CONSOLE_LOGGER,
  zulip?: ZulipConfig,
): BridgeReplyProvider {
  const seam = readRuntimeSeam(env);
  if (seam.urlFrom !== "AGENT_RUNTIME_URL" || seam.keyFrom !== "AGENT_RUNTIME_KEY") {
    // Not fatal — a host installed by an older lane still works — but said out
    // loud, because a legacy name that nothing writes any more otherwise
    // survives for years by simply continuing to work.
    logger.warn(
      `[inbound] runtime seam resolved from legacy names (url=${seam.urlFrom} key=${seam.keyFrom})`,
    );
  }
  const profile = readAgencyProfile(profileDir);
  for (const note of profile.notes) logger.info(`[inbound] agency: ${note}`);
  const build = createSystemMessageBuilder({
    buddyName: buddyDisplayName(env),
    profile,
  });
  return createRuntimeReplyProvider({
    endpoint: seam.url,
    apiKey: seam.key,
    model: seam.model,
    sessionHeader: seam.sessionHeader,
    loadImage: zulip ? (url) => downloadRuntimeImage(zulip, url) : undefined,
    systemMessage: (input) => build({ senderDisplayName: input.senderName }),
  });
}

function turnsPerHour(env: BridgeRuntimeEnvironment): number | undefined {
  const declared = Number(env.BUDDY_TURNS_PER_HOUR);
  return Number.isInteger(declared) && declared > 0 ? declared : undefined;
}

/**
 * Where the poller says it can hear. One canonical path, so the drill, the
 * evidence collector and the local harness cannot each invent their own.
 */
export function pollerStatePath(queueDirectory: string): string {
  return join(queueDirectory, "state", "poller.json");
}

export interface BridgeRuntime {
  bridge: EventBridge;
  queue: FileReplyQueue;
  stop: () => Promise<void>;
}

/**
 * Wire the whole runtime from the environment.
 *
 * THE GATE ORDER IS PART OF THE CONTRACT. The profile custody gate runs FIRST,
 * before a socket is opened or a queue directory is created, because it is the
 * one gate about what this process may READ. Everything after it is about what
 * it may reach.
 */
export async function buildRuntime(
  env: BridgeRuntimeEnvironment = process.env,
  logger: BridgeEventLogger = CONSOLE_LOGGER,
): Promise<BridgeRuntime> {
  const profileDir = assertProfileMountIsSafe(env.BUDDY_PROFILE_DIR);
  const queueDirectory = env.BUDDY_BRIDGE_QUEUE_DIR?.trim();
  if (!queueDirectory) {
    // `refusing to start:` is the classification, not decoration — it is what
    // routes this to exit 78 instead of a restart loop (scar R10).
    throw new Error(
      "refusing to start: the bridge requires a durable queue directory " +
        "(BUDDY_BRIDGE_QUEUE_DIR is not declared)",
    );
  }
  const zulip = zulipConfigFromEnv(env as Record<string, string | undefined>);
  const replySender = createZulipReplySender(zulip);
  // ONE rotation store for both triggers: the /reset command (EventBridge) and
  // the automatic exhaustion recovery (reply provider wrapper). Two stores
  // writing the same session header would rotate past each other.
  const sessionRotations = new SessionRotations(
    join(queueDirectory, "state", "session-rotations.json"),
  );
  const queue = new FileReplyQueue({
    directory: queueDirectory,
    // Wrapped so a wedged runtime session rotates instead of answering every
    // future turn with the same exhaustion error (see the regression in
    // runtime-adapter/session-recovery.ts).
    replyProvider: withSessionRecovery({
      provider: configuredReplyProvider(env, profileDir, logger, zulip),
      // The SAME store the /reset command writes (wired to EventBridge below)
      // — one rotation state, two triggers.
      rotations: sessionRotations,
      buddyName: buddyDisplayName(env),
      log: (line) => logger.info(line),
    }),
    replySender,
    logger,
  });
  const lock = await acquireSingletonLock(join(queueDirectory, "bridge.lock"));
  await queue.start();
  const bridge = new EventBridge({
    api: createZulipEventsApi(zulip),
    inbox: queue,
    watermark: new DurableWatermark(join(queueDirectory, "state", "watermark.json")),
    bot: { userId: await getOwnUserId(zulip), email: zulip.botEmail },
    breaker: new TurnBreaker({ limitPerHour: turnsPerHour(env) }),
    logger,
    notify: replySender,
    buddyName: buddyDisplayName(env),
    sessionRotations,
    onRegistered: ({ registrations }) =>
      writePollerState(pollerStatePath(queueDirectory), registrations),
  });
  return { bridge, queue, stop: () => lock.release() };
}

/**
 * Which exit code a startup failure deserves.
 *
 * A configuration refusal will not fix itself, so it exits 78 and the unit
 * refuses to restart on it (scar R10). Anything else — a runtime that is not up
 * yet, a Zulip that is still starting — is transient, exits 1, and systemd is
 * right to retry it. Getting this backwards in either direction is a real cost:
 * exiting 78 on a transient fault means a Buddy that stays dead after a reboot
 * race; exiting 1 on a misconfiguration means the eleven-restarts-a-minute
 * `activating` that no monitor can read.
 */
export function startupExitCode(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return /^refusing to start:/.test(message) ||
    /is not set\.|is not a valid HTTP header name|DIFFERENT values for/.test(message)
    ? BRIDGE_EXIT_CONFIG_REFUSED
    : 1;
}

if (import.meta.main) {
  const controller = new AbortController();
  let runtime: BridgeRuntime;
  try {
    runtime = await buildRuntime();
  } catch (error) {
    // NO DEGRADED MODE. Under the webhook shape a misconfigured bridge could
    // still answer 503 and stay up, which was worth something because Zulip was
    // the one calling. Nothing calls now: a bridge that cannot poll is a Buddy
    // that is silently deaf, and a process that exits is a better answer than a
    // process that is up and useless.
    console.error(`[inbound] bridge cannot start: ${(error as Error).message}`);
    process.exit(startupExitCode(error));
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      controller.abort();
      void runtime.stop().finally(() => process.exit(0));
    });
  }
  console.log("[inbound] Buddy bridge polling the Zulip events API (no listener)");
  await runtime.bridge.run(controller.signal);
}
