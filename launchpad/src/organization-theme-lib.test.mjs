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
  await writeFile(join(organizationRoot, "design-system", "launchpad.tokens.css"), themeCss("#0056d2"));
  await writeFile(join(organizationRoot, "launchpad", "app", "v1", "web", "style.css"), themeCss("#6058e9"));

  const theme = await readOrganizationLaunchpadTheme({
    companiesRoot: root,
    organization: { path: "organizations/Example_GEN3", status: "mounted" },
  });

  expect(theme.source).toBe("design-system/launchpad.tokens.css");
  expect(theme.light["--accent"]).toBe("#0056d2");
});

test("Organization theme odmítne aktivní CSS hodnoty i symlink mimo Organizaci", async () => {
  const root = await makeOrganizationRoot();
  const organizationRoot = join(root, "organizations", "Example_GEN3");
  const themePath = join(organizationRoot, "design-system", "launchpad.tokens.css");
  await mkdir(join(organizationRoot, "design-system"), { recursive: true });
  await writeFile(join(root, "outside.css"), themeCss("#ef4444"));
  await symlink(join(root, "outside.css"), themePath);

  const escaped = await readOrganizationLaunchpadTheme({
    companiesRoot: root,
    organization: { path: "organizations/Example_GEN3", status: "mounted" },
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

function themeCss(accent) {
  return `
    :root {
      --bg: #ffffff;
      --surface: #ffffff;
      --text: #111827;
      --accent: ${accent};
      --font-body: system-ui, sans-serif;
    }
    [data-theme="dark"] {
      --bg: #111827;
      --surface: #1f2937;
      --text: #f9fafb;
      --accent: ${accent};
    }
  `;
}
