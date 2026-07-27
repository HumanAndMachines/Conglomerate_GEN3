const maxFallbackAttempts = 20;

export async function startLaunchpadWithPortPolicy({
  requestedPort,
  host = "127.0.0.1",
  explicitPort,
  shouldOpen,
  shouldReuse = shouldOpen,
  startServer,
  isRunningExpectedLaunchpad = async () => false,
  openExisting = async () => {},
}) {
  let candidatePort = requestedPort;

  for (let attempt = 0; attempt < maxFallbackAttempts; attempt += 1) {
    try {
      return { mode: "started", server: startServer(candidatePort) };
    } catch (error) {
      if (!isAddressInUse(error)) throw error;

      const candidateUrl = `http://${host}:${candidatePort}`;
      if (shouldReuse) {
        if (await isRunningExpectedLaunchpad(candidateUrl)) {
          if (shouldOpen) await openExisting(candidateUrl);
          return { mode: "reused", url: candidateUrl };
        }
        if (explicitPort) throw error;
      }

      if (explicitPort || candidatePort >= 65_535) throw error;
      candidatePort += 1;
    }
  }

  const error = new Error(`Launchpad nenašel volný port po ${maxFallbackAttempts} pokusech od ${requestedPort}.`);
  error.code = "EADDRINUSE";
  throw error;
}

function isAddressInUse(error) {
  return error?.code === "EADDRINUSE" || String(error?.message ?? error).includes("EADDRINUSE");
}
