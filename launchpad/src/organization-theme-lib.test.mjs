import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { extractLaunchpadTheme, readOrganizationLaunchpadTheme } from "./organization-theme-lib.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("extractLaunchpadTheme převede GEN2 design tokeny do bezpečného light/dark skinu", () => {
  const theme = extractLaunchpadTheme(`
    :root {
      --c-company-200: #bfdbfe;
      --c-company-400: #60a5fa;
      --c-company-500: #2563eb;
      --c-company-700: #1d4ed8;
      --c-company-800: #1e40af;
      --c-company-900: #172554;
      --bg: #ffffff;
      --surface: #ffffff;
      --text: #172554;
      --text-muted: #475569;
      --accent: var(--c-company-500);
      --accent-soft: rgba(37, 99, 235, 0.1);
      --font-body: "Inter", sans-serif;
      --r-sm: 4px;
    }
    [data-theme="dark"] {
      --bg: #020617;
      --surface: #0f172a;
      --text: #f8fafc;
      --accent: var(--c-company-400);
    }
  `);

  expect(theme.light).toMatchObject({
    "--bg": "#ffffff",
    "--surface": "#ffffff",
    "--text": "#172554",
    "--accent": "#2563eb",
    "--c-accent-200": "#bfdbfe",
    "--c-accent-500": "#2563eb",
    "--c-accent-700": "#1d4ed8",
    "--font-heading": '"Inter", sans-serif',
  });
  expect(theme.dark).toMatchObject({
    "--bg": "#020617",
    "--surface": "#0f172a",
    "--text": "#f8fafc",
    "--accent": "#60a5fa",
    "--c-accent-400": "#60a5fa",
  });
});

test("Organization theme preferuje explicitní design-system adaptér před GEN2 fallbackem", async () => {
  const root = await makeOrganizationRoot();
  const organizationRoot = join(root, "organizations", "Example_GEN3");
  await mkdir(join(organizationRoot, "design-system"), { recursive: true });
  await mkdir(join(organizationRoot, "launchpad", "app", "v1", "web"), { recursive: true });
  await writeDesignSystemConfig(organizationRoot);
  await writeFile(
    join(organizationRoot, "design-system", "launchpad.tokens.css"),
    themeCss("#0056d2", {
      darkAccent: "var(--brand-dark, #f97316)",
      onAccentLight: "#ffffff",
      onAccentDark: "#111827",
    }),
  );
  await writeFile(join(organizationRoot, "launchpad", "app", "v1", "web", "style.css"), themeCss("#6058e9"));

  const theme = await readExampleTheme(root);

  expect(theme.source).toBe("design-system/launchpad.tokens.css");
  expect(theme.light["--accent"]).toBe("#0056d2");
  expect(theme.light["--on-accent"]).toBe("#ffffff");
  expect(theme.dark).toMatchObject({
    "--accent": "#f97316",
    "--on-accent": "#111827",
    "--c-accent-400": "#f97316",
    "--c-accent-500": "#f97316",
  });
});

test("Organization theme draft Design System neaktivuje a pokračuje GEN2 fallbackem", async () => {
  const root = await makeOrganizationRoot();
  const organizationRoot = join(root, "organizations", "Example_GEN3");
  await mkdir(join(organizationRoot, "design-system"), { recursive: true });
  await mkdir(join(organizationRoot, "launchpad", "app", "v1", "web"), { recursive: true });
  await writeDesignSystemConfig(organizationRoot, { contentStatus: "draft" });
  await writeFile(
    join(organizationRoot, "design-system", "launchpad.tokens.css"),
    themeCss("#0056d2", { onAccentLight: "#fff", onAccentDark: "#fff" }),
  );
  await writeFile(join(organizationRoot, "launchpad", "app", "v1", "web", "style.css"), themeCss("#6058e9"));

  const theme = await readExampleTheme(root);

  expect(theme.source).toBe("launchpad/app/v1/web/style.css");
  expect(theme.light["--accent"]).toBe("#6058e9");
});

test("Organization theme odmítne chybějící, cizí, neplatný i symlinkovaný Design System config", async () => {
  const scenarios = [
    {
      name: "missing",
      configure: async () => {},
    },
    {
      name: "slug-mismatch",
      configure: (organizationRoot) => writeDesignSystemConfig(organizationRoot, { slug: "example" }),
    },
    {
      name: "wrong-mode",
      configure: (organizationRoot) => writeDesignSystemConfig(organizationRoot, { mode: "template" }),
    },
    {
      name: "invalid-json",
      configure: (organizationRoot) => writeFile(
        join(organizationRoot, "design-system", "design-system.config.json"),
        "{invalid",
      ),
    },
    {
      name: "symlink",
      configure: async (organizationRoot) => {
        const target = join(organizationRoot, "design-system", "approved-config-target.json");
        await writeFile(target, designSystemConfig());
        await symlink(
          target,
          join(organizationRoot, "design-system", "design-system.config.json"),
          "file",
        );
      },
    },
  ];
  const results = [];

  for (const scenario of scenarios) {
    const root = await makeOrganizationRoot();
    const organizationRoot = join(root, "organizations", "Example_GEN3");
    await mkdir(join(organizationRoot, "design-system"), { recursive: true });
    await mkdir(join(organizationRoot, "launchpad", "app", "v1", "web"), { recursive: true });
    await writeFile(
      join(organizationRoot, "design-system", "launchpad.tokens.css"),
      themeCss("#0056d2", { onAccentLight: "#fff", onAccentDark: "#fff" }),
    );
    await writeFile(join(organizationRoot, "launchpad", "app", "v1", "web", "style.css"), themeCss("#6058e9"));
    await scenario.configure(organizationRoot);

    const theme = await readExampleTheme(root);
    results.push({
      name: scenario.name,
      source: theme?.source,
      accent: theme?.light?.["--accent"],
    });
  }

  expect(results).toEqual(scenarios.map(({ name }) => ({
    name,
    source: "launchpad/app/v1/web/style.css",
    accent: "#6058e9",
  })));
});

test("Schválený Design System bez on-accent v obou režimech se neaktivuje", async () => {
  const root = await makeOrganizationRoot();
  const organizationRoot = join(root, "organizations", "Example_GEN3");
  await mkdir(join(organizationRoot, "design-system"), { recursive: true });
  await mkdir(join(organizationRoot, "launchpad", "app", "v1", "web"), { recursive: true });
  await writeDesignSystemConfig(organizationRoot);
  await writeFile(
    join(organizationRoot, "design-system", "launchpad.tokens.css"),
    themeCss("#0056d2", { onAccentLight: "#fff" }),
  );
  await writeFile(join(organizationRoot, "launchpad", "app", "v1", "web", "style.css"), themeCss("#6058e9"));

  const theme = await readExampleTheme(root);

  expect(theme.source).toBe("launchpad/app/v1/web/style.css");
  expect(theme.light["--accent"]).toBe("#6058e9");
});

test("Organization theme odmítne aktivní CSS hodnoty i symlink mimo Organizaci", async () => {
  const root = await makeOrganizationRoot();
  const organizationRoot = join(root, "organizations", "Example_GEN3");
  const designSystemPath = join(organizationRoot, "design-system");
  const outsideDesignSystem = join(root, "outside-design-system");
  await mkdir(outsideDesignSystem, { recursive: true });
  await writeFile(join(outsideDesignSystem, "design-system.config.json"), designSystemConfig());
  await writeFile(
    join(outsideDesignSystem, "launchpad.tokens.css"),
    themeCss("#ef4444", { onAccentLight: "#fff", onAccentDark: "#fff" }),
  );
  await symlink(
    outsideDesignSystem,
    designSystemPath,
    process.platform === "win32" ? "junction" : "dir",
  );

  const escaped = await readOrganizationLaunchpadTheme({
    companiesRoot: root,
    organization: { slug: "Example", path: "organizations/Example_GEN3", status: "mounted" },
  });
  expect(escaped).toBeNull();

  expect(extractLaunchpadTheme(themeCss("url(https://attacker.example/pixel)"))).toBeNull();
  expect(extractLaunchpadTheme(themeCss('image-set("https://attacker.example/pixel" 1x)'))).toBeNull();
  expect(extractLaunchpadTheme(themeCss("u\\72l(https://attacker.example/pixel)"))).toBeNull();
});

test("Organization theme vyžaduje úplnou dark variantu", () => {
  expect(extractLaunchpadTheme(`
    :root {
      --bg: #ffffff;
      --surface: #ffffff;
      --text: #111827;
      --accent: #2563eb;
      --font-body: system-ui, sans-serif;
    }
  `)).toBeNull();
});

async function makeOrganizationRoot() {
  const root = await mkdtemp(join(tmpdir(), "launchpad-theme-"));
  tempRoots.push(root);
  await mkdir(join(root, "organizations", "Example_GEN3"), { recursive: true });
  return root;
}

function readExampleTheme(root) {
  return readOrganizationLaunchpadTheme({
    companiesRoot: root,
    organization: { slug: "Example", path: "organizations/Example_GEN3", status: "mounted" },
  });
}

async function writeDesignSystemConfig(
  organizationRoot,
  { slug = "Example", mode = "organization", contentStatus = "approved" } = {},
) {
  await writeFile(
    join(organizationRoot, "design-system", "design-system.config.json"),
    designSystemConfig({ slug, mode, contentStatus }),
  );
}

function designSystemConfig({
  slug = "Example",
  mode = "organization",
  contentStatus = "approved",
} = {}) {
  return JSON.stringify({
    schema_version: "design-system.v1",
    mode,
    organization: { slug, display_name: slug },
    content_status: contentStatus,
  });
}

function themeCss(
  accent,
  {
    darkAccent = accent,
    onAccentLight = null,
    onAccentDark = null,
  } = {},
) {
  return `
    :root {
      --bg: #ffffff;
      --surface: #ffffff;
      --text: #111827;
      --accent: ${accent};
      ${onAccentLight ? `--on-accent: ${onAccentLight};` : ""}
      --font-body: system-ui, sans-serif;
    }
    [data-theme="dark"] {
      --bg: #111827;
      --surface: #1f2937;
      --text: #f9fafb;
      --accent: ${darkAccent};
      ${onAccentDark ? `--on-accent: ${onAccentDark};` : ""}
    }
  `;
}
