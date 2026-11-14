#!/usr/bin/env node
// Writes the English source catalogs for the eventual-locales package from the code:
//   attendance/en.json    admin texts ("admin.…") and guest emails ("email.…"), sandbox pack
//   attendance-form/en.json  site component texts (Astro), bundled with the npm package
// Usage: node scripts/i18n-extract.mjs [catalogsDir]  (default: the linked eventual-locales)
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { flattenMessages } from "@vermeulen.solutions/eventual-locales";

const dir = process.argv[2] ?? "node_modules/@vermeulen.solutions/eventual-locales/catalogs";
const result = await build({
  stdin: {
    contents: 'export { ADMIN_EN } from "./src/admin/i18n.ts"; export { EMAIL_EN } from "./src/domain/messages.ts"; export { RSVP_EN } from "./astro/rsvp-i18n.ts";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  external: ["@vermeulen.solutions/eventual-locales", "@vermeulen.solutions/eventual-capacity", "astro:*"],
  logLevel: "error",
});
// Written inside the project so the bundle's bare imports resolve from its node_modules.
mkdirSync("node_modules/.cache", { recursive: true });
const temp = resolve("node_modules/.cache/i18n-extract.mjs");
writeFileSync(temp, result.outputFiles[0].text);
const mod = await import(pathToFileURL(temp).href);
rmSync(temp);
const write = (namespace, messages) => {
  mkdirSync(join(dir, namespace), { recursive: true });
  writeFileSync(join(dir, namespace, "en.json"), JSON.stringify(messages, null, 2) + "\n");
  console.log(`${namespace}/en.json: ${Object.keys(messages).length} messages`);
};
write("attendance", { ...flattenMessages(mod.ADMIN_EN, "admin."), ...flattenMessages(mod.EMAIL_EN, "email.") });
write("attendance-form", flattenMessages(mod.RSVP_EN));
