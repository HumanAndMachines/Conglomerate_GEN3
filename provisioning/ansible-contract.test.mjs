import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const ansibleRoot = join(import.meta.dir, "ansible");

async function readYaml(path) {
  return Bun.YAML.parse(await readFile(path, "utf8"));
}

async function ansibleFiles() {
  const entries = await readdir(ansibleRoot, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

test("operator plane YAML parses and the playbook stays Buddy/Linux scoped", async () => {
  const files = await ansibleFiles();
  expect(files.length).toBeGreaterThanOrEqual(5);
  for (const file of files) {
    expect(await readYaml(file)).toBeDefined();
  }

  const [play] = await readYaml(join(ansibleRoot, "playbooks", "buddy-linux.yml"));
  expect(play).toMatchObject({
    hosts: "buddy_hosts",
    gather_facts: true,
    become: true,
    vars: { lazurio_resident_profile: "buddy" },
    roles: [
      { role: "resident_preflight" },
      { role: "resident_host_base" },
      { role: "resident_runtime_base" },
      { role: "resident_network" },
      { role: "lazurio_resident" },
    ],
  });
  expect(JSON.stringify(play)).not.toContain("ai-colleague");
});

test("every role task uses one fully qualified builtin action", async () => {
  const taskFiles = (await ansibleFiles()).filter((path) => path.includes("/tasks/"));
  const metadataKeys = new Set([
    "name",
    "when",
    "loop",
    "register",
    "changed_when",
    "check_mode",
    "delegate_to",
    "become",
    "become_user",
    "environment",
    "args",
    "failed_when",
  ]);

  for (const file of taskFiles) {
    const tasks = await readYaml(file);
    for (const task of tasks) {
      const actionKeys = Object.keys(task).filter((key) => !metadataKeys.has(key));
      expect(actionKeys, `${relative(repositoryRoot, file)}: ${task.name}`).toHaveLength(1);
      expect(actionKeys[0], `${relative(repositoryRoot, file)}: ${task.name}`)
        .toMatch(/^ansible\.builtin\.[a-z_]+$/u);
    }
  }
});

test("operator plane delegates immutable lifecycle to the official rollout", async () => {
  const lifecycleTasks = await readFile(
    join(ansibleRoot, "roles", "lazurio_resident", "tasks", "main.yml"),
    "utf8",
  );
  for (const required of [
    "buddy-rollout.mjs",
    "--archive",
    "--checksum",
    "--install-root",
    "--mount-source",
    "--environment-file",
    "--hermes-root",
    "ansible_check_mode",
    "lazurio_rollout_command.rc == 0",
  ]) {
    expect(lifecycleTasks).toContain(required);
  }
  for (const duplicateMechanism of [
    "ansible.builtin.unarchive",
    "ansible.builtin.git",
    "ansible.builtin.get_url",
    "ansible.builtin.uri",
    "ansible.builtin.shell",
  ]) {
    expect(lifecycleTasks).not.toContain(duplicateMechanism);
  }
});

test("host baseline preserves existing custody and keeps bridge unprivileged", async () => {
  const tasks = await readYaml(
    join(ansibleRoot, "roles", "resident_host_base", "tasks", "main.yml"),
  );
  const bridge = tasks.find((task) => task.name === "Keep the bridge identity outside supplementary groups");
  expect(bridge["ansible.builtin.user"]).toMatchObject({
    groups: "",
    append: false,
    system: true,
  });
  const custody = tasks.find((task) => task.name === "Materialize empty custody files without replacing existing values");
  expect(custody["ansible.builtin.copy"]).toMatchObject({
    content: "",
    dest: "{{ item.path }}",
    group: "{{ item.group }}",
    mode: "{{ item.mode }}",
    force: false,
  });
  expect(custody.loop.find(
    (item) => item.path === "{{ lazurio_custody_root }}/hermes-gateway.env",
  )).toEqual({
    path: "{{ lazurio_custody_root }}/hermes-gateway.env",
    group: "{{ lazurio_runtime_user }}",
    mode: "0640",
  });
  const defaults = await readYaml(
    join(ansibleRoot, "roles", "resident_host_base", "defaults", "main.yml"),
  );
  expect(defaults.lazurio_base_packages).toContain("sudo");
  const directories = tasks.find(
    (task) => task.name === "Converge operator-owned Resident directories",
  );
  expect(directories.loop.find((item) => item.path === "{{ lazurio_custody_root }}"))
    .toEqual({
      path: "{{ lazurio_custody_root }}",
      group: "{{ lazurio_runtime_user }}",
      mode: "0750",
    });
  expect(directories.loop.find(
    (item) => item.path === "{{ lazurio_bridge_state_root }}/queue",
  )).toEqual({
    path: "{{ lazurio_bridge_state_root }}/queue",
    owner: "{{ lazurio_bridge_user }}",
    group: "{{ lazurio_bridge_user }}",
    mode: "0700",
  });
  expect(directories["ansible.builtin.file"].owner)
    .toBe("{{ item.owner | default('root') }}");
});

test("runtime baseline invokes the exact pinned Hermes service interface", async () => {
  const tasks = await readYaml(
    join(ansibleRoot, "roles", "resident_runtime_base", "tasks", "main.yml"),
  );
  const defaults = await readYaml(
    join(ansibleRoot, "roles", "resident_runtime_base", "defaults", "main.yml"),
  );
  expect(defaults.lazurio_gbrain_home).toBe("/var/lib/{{ lazurio_runtime_user }}");
  expect(tasks.find(
    (task) => task.name === "Inspect the local PGLite engine",
  )["ansible.builtin.stat"].path).toBe(
    "{{ lazurio_gbrain_home }}/.gbrain/brain.pglite/PG_VERSION",
  );
  for (const taskName of [
    "Materialize the exact Hermes fork commit",
    "Materialize the exact GBrain fork commit",
  ]) {
    expect(tasks.find((task) => task.name === taskName)["ansible.builtin.git"])
      .toMatchObject({ depth: 1, single_branch: true, force: false });
  }
  expect(tasks.find(
    (task) => task.name === "Materialize the exact Hermes fork commit",
  )["ansible.builtin.git"].version).toBe("{{ lazurio_hermes_pin.release_tag }}");
  expect(tasks.find(
    (task) => task.name === "Keep the uv environment marker operator-owned",
  )["ansible.builtin.file"]).toMatchObject({
    path: "{{ lazurio_hermes_root }}/venv/.lock",
    owner: "root",
    group: "root",
    mode: "0644",
  });
  const service = tasks.find(
    (task) => task.name === "Install the upstream Hermes gateway service without starting it",
  );
  expect(service["ansible.builtin.command"].argv).toEqual([
    "{{ lazurio_hermes_root }}/venv/bin/hermes",
    "gateway",
    "install",
    "--system",
    "--run-as-user",
    "{{ lazurio_runtime_user }}",
    "--no-start-now",
    "--start-on-login",
  ]);
  expect(service.changed_when).toBe(false);
  const credentialSeam = tasks.find(
    (task) => task.name === "Prove the private Hermes API and bridge credential seam without printing values",
  );
  expect(credentialSeam["ansible.builtin.command"].argv.join("\n"))
    .toContain("API_SERVER_ENABLED");
  expect(credentialSeam["ansible.builtin.command"].argv.join("\n"))
    .toContain("AGENT_RUNTIME_KEY");
  expect(credentialSeam.changed_when).toBe(false);
  expect(tasks.find(
    (task) => task.name === "Point Hermes at its root-custodied private environment",
  )["ansible.builtin.file"]).toMatchObject({ follow: false, force: false });
});

test("network baseline preserves UFW argv tokens through YAML parsing", async () => {
  const tasks = await readYaml(
    join(ansibleRoot, "roles", "resident_network", "tasks", "main.yml"),
  );
  expect(tasks[0]["ansible.builtin.command"].argv).toEqual([
    "ufw",
    "status",
    "verbose",
  ]);
  expect(tasks[1]["ansible.builtin.command"].argv).toEqual([
    "ufw",
    "allow",
    "in",
    "on",
    "{{ lazurio_tailnet_interface }}",
    "to",
    "any",
    "port",
    "{{ item | string }}",
    "proto",
    "tcp",
  ]);
  expect(tasks.find((task) => task.name === "Set the default inbound policy to deny").when)
    .toContain("'deny (incoming)' not in lazurio_ufw_status_before.stdout");
  expect(tasks.find((task) => task.name === "Set the default outbound policy to allow").when)
    .toContain("'allow (outgoing)' not in lazurio_ufw_status_before.stdout");
  expect(tasks.find((task) => task.name === "Enable UFW after the private allow rules exist").when)
    .toContain("'Status: active' not in lazurio_ufw_status_before.stdout");
});

test("example inventory contains placeholders only and no cohort identity", async () => {
  const inventoryPath = join(ansibleRoot, "inventory.example.yml");
  const inventoryText = await readFile(inventoryPath, "utf8");
  const inventory = await readYaml(inventoryPath);
  const hosts = inventory.all.children.buddy_hosts.hosts;
  expect(Object.keys(hosts)).toEqual(["buddy-host.example.invalid"]);
  expect(inventoryText.toLowerCase()).not.toMatch(/matty|friday/u);
  expect(inventoryText).not.toMatch(/password|private_key|token|secret\s*:/iu);
  for (const key of [
    "lazurio_bun_path",
    "lazurio_recovery_attestation_file",
    "lazurio_artifact_archive",
    "lazurio_artifact_checksum",
    "lazurio_personalspace_source",
    "lazurio_bridge_environment_file",
    "lazurio_hermes_root",
  ]) {
    expect(hosts["buddy-host.example.invalid"][key]).toMatch(/^\//u);
  }
});

test("operator plane remains source-only and manuals separate deploy from update", async () => {
  const contract = JSON.parse(
    await readFile(join(repositoryRoot, "distribution", "contract.v1.json"), "utf8"),
  );
  expect(contract.source_includes.some((path) => path.startsWith("provisioning/"))).toBe(false);
  expect(contract.generated_paths.some((path) => path.startsWith("provisioning/"))).toBe(false);

  const operatorManual = await readFile(join(import.meta.dir, "README.md"), "utf8");
  const updateManual = await readFile(
    join(repositoryRoot, "manual", "update-installed-resident.md"),
    "utf8",
  );
  expect(operatorManual).toContain("source-only operator plane");
  expect(operatorManual).toContain("provider recovery checkpoint");
  expect(operatorManual).toContain("PGLite");
  expect(operatorManual).toContain("nevytváří vlastní updater, daemon, sandbox, ACL ani fleet control plane");
  expect(operatorManual.toLowerCase()).not.toMatch(/matty|friday/u);
  expect(updateManual).toContain("Updater není Ansible a Ansible není updater");
  expect(updateManual).toContain("Lokální úprava je legitimní drift");
});

test("documented root command enters the Ansible directory and discovers its config", async () => {
  if (process.platform === "win32") {
    return;
  }

  const sandbox = await mkdtemp(join(tmpdir(), "lazurio-ansible-entrypoint-"));
  const probePath = join(sandbox, "ansible-playbook");
  const resultPath = join(sandbox, "result.txt");
  const inventoryPath = join(sandbox, "inventory.yml");

  try {
    await writeFile(inventoryPath, "all: {}\n", "utf8");
    await writeFile(
      probePath,
      `#!/bin/sh
set -eu
test -f "$PWD/ansible.cfg"
test -d "$PWD/roles/resident_host_base"
printf '%s\\n' "$PWD" "$@" > "$LAZURIO_ANSIBLE_PROBE_RESULT"
`,
      "utf8",
    );
    await chmod(probePath, 0o755);

    const command = [
      "cd provisioning/ansible",
      `ansible-playbook -i "${inventoryPath}" playbooks/buddy-linux.yml --check --diff`,
    ].join(" && ");
    const processResult = Bun.spawn(["sh", "-c", command], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${sandbox}:${process.env.PATH ?? ""}`,
        LAZURIO_ANSIBLE_PROBE_RESULT: resultPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processResult.exited,
      new Response(processResult.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const [workingDirectory, ...args] = (await readFile(resultPath, "utf8"))
      .trimEnd()
      .split("\n");
    expect(await realpath(workingDirectory)).toBe(await realpath(ansibleRoot));
    expect(args).toEqual([
      "-i",
      inventoryPath,
      "playbooks/buddy-linux.yml",
      "--check",
      "--diff",
    ]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
