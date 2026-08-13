export function discoveryContractFailures({
  portOverlaps = [],
  moduleListenerDrifts = [],
} = {}) {
  return [
    ...portOverlaps
      .filter((overlap) => overlap.conflict !== false)
      .map((overlap) => `port ${overlap.port}: ${overlap.classification}`),
    ...moduleListenerDrifts
      .map((drift) => `${drift.module_lease}: module listener drift`),
  ];
}
