// Compares the built manifest's trust contract with trust-contract.json. Run after `npm run build`.
// `node scripts/trust-contract.mjs --write` refreshes the snapshot (only when a change is intended).
import { readFileSync, writeFileSync } from "node:fs";

const m = JSON.parse(readFileSync(new URL("../dist/manifest.json", import.meta.url), "utf8"));
const contract = {
  capabilities: [...(m.capabilities ?? [])].sort(),
  allowedHosts: [...(m.allowedHosts ?? [])].sort(),
  hooks: [...(m.hooks ?? [])].map((h) => (typeof h === "string" ? h : h.name)).sort(),
  publicRoutes: (m.routes ?? []).filter((r) => r.public).map((r) => `${(r.methods ?? []).join(",")} ${r.name}`).sort(),
  storage: Object.fromEntries(
    Object.entries(m.storage ?? {}).map(([k, v]) => [
      k,
      (v.indexes ?? []).map((i) => (Array.isArray(i) ? i.join("+") : i)).sort(),
    ])
  ),
};

const file = new URL("../trust-contract.json", import.meta.url);
const text = JSON.stringify(contract, null, 2) + "\n";

if (process.argv.includes("--write")) {
  writeFileSync(file, text);
  console.log("trust-contract.json written");
  process.exit(0);
}

let saved = "";
try {
  // Git may check the file out with CRLF line endings on Windows; only the content matters.
  saved = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
} catch {
  console.error("trust-contract.json not found. Run with --write to generate it.");
  process.exit(1);
}

if (saved !== text) {
  console.error(
    "The trust contract changed. If this is intended (administrators must approve the plugin again), run: node scripts/trust-contract.mjs --write\n"
  );
  console.error("Expected (trust-contract.json):\n" + saved + "\nBuilt:\n" + text);
  process.exit(1);
}

console.log("Trust contract unchanged.");
