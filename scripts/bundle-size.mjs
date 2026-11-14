// The registry refuses any file over 128 KiB (suite P22). Keep 8 KiB of room for hotfixes.
// Raised from 112 KiB in round 10: the organiser screens (question rows, door check-in, search,
// settings page, plain-language texts in two languages) added about 11 KB.
import { statSync } from "node:fs";

const BUDGET = 120 * 1024; // 122,880 bytes
const size = statSync(new URL("../dist/plugin.mjs", import.meta.url)).size;
const line = `dist/plugin.mjs: ${size} bytes of ${BUDGET} (${((size / BUDGET) * 100).toFixed(1)}%)`;
if (size > BUDGET) {
  console.error(`${line}: over budget. Trim before adding code.`);
  process.exit(1);
}
console.log(line);
console.log(`Registry limit: 131072 bytes; ${131072 - size} bytes left.`);
