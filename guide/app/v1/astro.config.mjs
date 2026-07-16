import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import tailwindcss from "@tailwindcss/vite";

// Interaktivní průvodce Conglomerate GEN3. SSR mód zachovává
// GEN2 guide pattern; content je obecný root-level onboarding.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  server: {
    host: "127.0.0.1",
    port: 5281,
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
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
