import {
  installResidentArtifact,
  revertResidentActivation,
} from "./updater-lib.mjs";
import { installBuddyBridgeService } from "./buddy-service-lib.mjs";

export async function rolloutBuddyArtifact({
  archivePath,
  checksumPath,
  installRoot,
  channel,
  mutableMountSources = {},
  serviceOptions = {},
  updaterInstaller = installResidentArtifact,
  serviceInstaller = installBuddyBridgeService,
  activationReverter = revertResidentActivation,
} = {}) {
  const resident = await updaterInstaller({
    archivePath,
    checksumPath,
    installRoot,
    expectedProfile: "buddy",
    expectedChannel: channel,
    mutableMountSources,
  });
  try {
    const services = await serviceInstaller({ ...serviceOptions, installRoot });
    return {
      schema_version: "lazurio.buddy-rollout.result.v1",
      status: resident.status === "noop" ? "reconciled" : resident.status,
      resident,
      services,
    };
  } catch (serviceError) {
    const compensation = [];
    const failures = [];
    if (["installed", "updated"].includes(resident.status)) {
      try {
        const reverted = await activationReverter({
          installRoot,
          expectedProfile: "buddy",
          failedArtifactId: resident.active,
        });
        compensation.push(reverted.status);
        if (resident.previous) {
          try {
            await serviceInstaller({ ...serviceOptions, installRoot });
            compensation.push("previous_services_reconciled");
          } catch (recoveryError) {
            failures.push(`previous service recovery failed: ${messageOf(recoveryError)}`);
          }
        }
      } catch (revertError) {
        failures.push(`resident activation revert failed: ${messageOf(revertError)}`);
      }
    } else {
      compensation.push("resident_activation_unchanged");
    }
    const outcome = failures.length === 0
      ? `compensated (${compensation.join(", ")})`
      : `compensation incomplete (${[...compensation, ...failures].join("; ")})`;
    throw new Error(`Buddy rollout service gate failed and was ${outcome}: ${messageOf(serviceError)}`);
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
