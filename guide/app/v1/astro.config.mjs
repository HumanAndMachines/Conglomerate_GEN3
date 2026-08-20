import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import tailwindcss from "@tailwindcss/vite";

const moduleManifest = JSON.parse(
  readFileSync(new URL("../../lazurio.module.json", import.meta.url), "utf8"),
);
const mainLease = moduleManifest.port_leases?.find((lease) => lease.id === "main");
if (
  !mainLease ||
  typeof mainLease.host !== "string" ||
  !Number.isInteger(mainLease.port)
) {
  throw new Error("guide/lazurio.module.json must declare a valid main lease");
}

// Interaktivní průvodce Lazuriem. SSR mód zachovává
// GEN2 guide pattern; content je obecný root-level onboarding. Runtime scripts
// kontrolují Launchpad injection před spuštěním Astro; samotný config zůstává
// statický, protože Astro podporuje objektový defineConfig kontrakt.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  server: {
    host: mainLease.host,
    port: mainLease.port,
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      strictPort: true,
      fs: {
        // Sourozenecký ../content/ a root-level manuály vyžadují přístup mimo app/.
        allow: [".."],
      },
      watch: {
        ignored: ["!../content/**"],
      },
    },
  },
});
