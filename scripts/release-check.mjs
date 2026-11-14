// One command that says whether this package is ready to publish. It never publishes, tags,
// commits or uploads. Run it through npm so the npm executable is available:
//   npm run release:check
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const isTickets = pkg.name === "@vermeulen.solutions/eventual-tickets";
const npmCli = process.env.npm_execpath;

function run(label, args) {
  process.stdout.write(`- ${label} ... `);
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8", windowsHide: true })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        shell: process.platform === "win32",
      });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    console.error("failed\n");
    if (output.trim()) console.error(output.trim());
    process.exit(1);
  }
  console.log("ok");
  return output;
}

function fail(message) {
  console.error(`\nNot ready: ${message}`);
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(cwd, resolve(entry.parentPath ?? dir, entry.name)).split(sep).join("/"));
}

console.log(`Release check for ${pkg.name}@${pkg.version}`);

// 1. Tests (they build the plugin first, then check the trust contract and the bundle budget).
run("npm test", ["test"]);

// 2. Type check.
run("npx tsc --noEmit -p .", ["exec", "--", "tsc", "--noEmit", "-p", "."]);

// 3. Manifest check.
run("npm run validate", ["run", "validate"]);

// 4. Build.
run("npm run build", ["run", "build"]);

// 5. The built manifest carries the same version as package.json.
const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
if (manifest.version !== pkg.version) {
  fail(`dist/manifest.json says ${manifest.version || "(none)"} but package.json says ${pkg.version}. Run npm run build.`);
}
console.log(`- manifest version ${manifest.version} matches package.json`);

// 6. The changelog has a heading for this version that is not still marked unreleased.
const changelog = readFileSync("CHANGELOG.md", "utf8");
const heading = changelog.split(/\r?\n/).find((line) => new RegExp(`^##\\s+${pkg.version.replace(/\./g, "\\.")}(?:\\s|\\(|$)`).test(line));
if (!heading) fail(`CHANGELOG.md has no "## ${pkg.version}" heading.`);
if (/unreleased/i.test(heading)) fail(`CHANGELOG.md still says "${heading.trim()}". Replace "unreleased" with the release date.`);
console.log(`- changelog heading: ${heading.trim()}`);

// 7. What npm would publish: the built files, the manifest, the docs and every astro file,
//    and nothing from src/, tests/, scripts/, docs/ or node_modules/.
const packedJson = run("npm pack --dry-run --json", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
let packed;
try {
  packed = JSON.parse(packedJson);
} catch {
  fail("npm pack --dry-run --json did not return JSON.");
}
const files = new Set((packed[0]?.files ?? []).map((file) => file.path.split(sep).join("/")));
const required = ["dist/plugin.mjs", "dist/index.mjs", "dist/manifest.json", "emdash-plugin.jsonc", "README.md", "CHANGELOG.md", "LICENSE"];
if (existsSync("astro")) required.push(...walk("astro"));
const missing = required.filter((file) => !files.has(file));
if (missing.length) fail(`npm pack is missing: ${missing.join(", ")}.`);
const forbidden = [...files].filter((file) => /^(src|tests|scripts|docs|node_modules)\//.test(file));
if (forbidden.length) fail(`npm pack includes files it should not: ${forbidden.slice(0, 10).join(", ")}.`);
console.log(`- npm pack lists ${files.size} files, including every required file and no src/tests/scripts/docs/node_modules`);

// 8. Astro files are self-contained: runtime imports point inside astro/ or at a declared
//    package. Type-only imports/re-exports are erased by the consumer's compiler and may point
//    at the packed src/domain/types.ts (Attendance).
const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
const astroRoot = resolve(cwd, "astro") + sep;
const problems = [];
for (const file of walk("astro")) {
  const text = readFileSync(resolve(cwd, file), "utf8");
  const specifiers = [];
  for (const match of text.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) specifiers.push(match[1]);
  for (const match of text.matchAll(/^\s*export\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) specifiers.push(match[1]);
  for (const match of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specifiers.push(match[1]);
  for (const specifier of specifiers) {
    if (specifier.startsWith(".")) {
      const target = resolve(dirname(resolve(cwd, file)), specifier);
      if (!target.startsWith(astroRoot)) problems.push(`${file} imports ${specifier} (outside astro/)`);
    } else if (specifier.startsWith("node:")) {
      // Node built-ins are available to the site's build.
    } else {
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (!declared.has(name)) problems.push(`${file} imports ${specifier} (not in dependencies or peerDependencies)`);
    }
  }
}
if (problems.length) fail(`astro/ is not self-contained:\n  ${problems.join("\n  ")}`);
console.log("- astro/ runtime imports stay inside astro/ or use declared packages");

// 9. Not marked private.
if (pkg.private === true) fail('package.json has "private": true.');
console.log("- package.json is not private");

if (isTickets) {
  // 10. The licence public key is set and the build date is today or yesterday (UTC).
  const licenceBuild = readFileSync("src/licence-build.ts", "utf8");
  const key = /LICENCE_PUBLIC_KEY\s*=\s*["']([^"']*)["']/.exec(licenceBuild)?.[1] ?? "";
  if (!key) fail("src/licence-build.ts has an empty LICENCE_PUBLIC_KEY. Run scripts/licence-keygen.mjs first.");
  const buildDate = /BUILD_DATE\s*=\s*["']([^"']*)["']/.exec(licenceBuild)?.[1] ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (buildDate !== today && buildDate !== yesterday) {
    fail(`BUILD_DATE is ${buildDate || "(none)"}; it must be ${today} or ${yesterday}. Run npm run release:date.`);
  }
  console.log(`- licence key present; BUILD_DATE ${buildDate} is today or yesterday (UTC)`);

  // 11. The licence file is the real one, not the old notice or the draft placeholders.
  const licence = readFileSync("LICENSE", "utf8");
  if (licence.includes("No licence to use, copy, modify or")) fail("LICENSE still carries the old notice.");
  if (licence.includes("[address]") || licence.includes("[date of publication]")) {
    fail("LICENSE still has draft placeholders. Fill licence-facts.json and run npm run licence:apply.");
  }
  console.log("- LICENSE is the real licence text, without the old notice or placeholders");
}

console.log(`\nReady to publish ${pkg.name}@${pkg.version}. Nothing was published.`);
