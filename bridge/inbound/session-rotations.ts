// Durable, idempotent /reset semantics for callers that supply their own
// X-Hermes-Session-Id. Old transcripts stay in Hermes; future turns use a new id.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

interface StoredRotations {
  version: 1;
  routes: Record<string, number>;
}

export class SessionRotations {
  private readonly path: string;
  private cached?: StoredRotations;

  constructor(path: string) {
    if (!path.trim()) throw new Error("Session rotations path is required");
    this.path = path;
  }

  private async read(): Promise<StoredRotations> {
    if (this.cached) return this.cached;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as StoredRotations;
      if (parsed.version === 1 && parsed.routes && typeof parsed.routes === "object") {
        this.cached = parsed;
        return parsed;
      }
    } catch {
      // Missing state means no route has been reset yet.
    }
    this.cached = { version: 1, routes: {} };
    return this.cached;
  }

  async resolve(baseSessionId: string): Promise<string> {
    const state = await this.read();
    const resetMessageId = state.routes[baseSessionId];
    return Number.isInteger(resetMessageId) && resetMessageId! > 0
      ? `${baseSessionId}-r${resetMessageId}`
      : baseSessionId;
  }

  async resetAt(baseSessionId: string, messageId: number): Promise<string> {
    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new Error("Reset message id must be a positive integer");
    }
    const state = await this.read();
    if ((state.routes[baseSessionId] ?? 0) >= messageId) return this.resolve(baseSessionId);
    const next: StoredRotations = {
      version: 1,
      routes: { ...state.routes, [baseSessionId]: messageId },
    };
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.session-rotations.${randomUUID()}.tmp`);
    try {
      await Bun.write(temporary, `${JSON.stringify(next)}\n`);
      await chmod(temporary, 0o600);
      await syncPath(temporary);
      await rename(temporary, this.path);
      await syncPath(directory);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    this.cached = next;
    return this.resolve(baseSessionId);
  }
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

