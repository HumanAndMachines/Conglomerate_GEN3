export function renderHumanDoctorReport(doctorReport) {
  const lines = [`${doctorReport.summary.status} - ${doctorReport.scope.name}`];
  for (const check of doctorReport.checks) {
    lines.push(`${check.status} - ${check.id}: ${check.message}`);
    if (check.status === "blocked") {
      lines.push(`  ! ${check.blocked_reason}`);
      lines.push(`  → ${check.remedy}`);
    }
    if (check.status === "not_applicable") {
      lines.push(`  ~ ${check.not_applicable_reason} · vlastní: ${check.owner}`);
    }
    if (check.status === "ok" || (check.details ?? []).length === 0) continue;
    for (const detail of check.details) lines.push(`  - ${detail}`);
  }
  for (const child of doctorReport.children ?? []) {
    lines.push(
      `${child.outcome} - podřízený doctor ${child.declaration_path} `
      + `(${child.invoked_command.join(" ")})`,
    );
    for (const failure of child.failures ?? []) lines.push(`  - ${failure}`);
  }
  return lines.join("\n");
}
