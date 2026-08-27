/**
 * Validate the OpenRouter preset's model ids against the live catalogue.
 *
 *   node dev/check-models.mjs     # or: npm run check:models
 *
 * Model ids rot — vendors retire them and OpenRouter renames namespaces — and a
 * stale id fails at request time as an opaque 400. This is deliberately NOT part
 * of `npm test`: it needs the network, and a unit suite that fails because
 * someone is on a train is worse than no check at all.
 */
import { readFileSync } from "node:fs";

const CATALOGUE = "https://openrouter.ai/api/v1/models";
const SOURCE = new URL("../src/db/db.ts", import.meta.url).pathname;

const src = readFileSync(SOURCE, "utf8");
const preset = src.split('id: "openrouter"')[1];
if (!preset) {
  console.error("No openrouter preset found in src/db/db.ts.");
  process.exit(1);
}

const defaultModel = preset.match(/model: "([^"]+)"/)?.[1];
const known = [...(preset.split("knownModels: [")[1]?.split("]")[0] ?? "").matchAll(/"([^"]+)"/g)]
  .map((m) => m[1]);
const wanted = [...new Set([defaultModel, ...known].filter(Boolean))];

const res = await fetch(CATALOGUE).catch((err) => {
  console.error(`Could not reach ${CATALOGUE}: ${err.message}`);
  process.exit(2);
});
if (!res.ok) {
  console.error(`${CATALOGUE} returned ${res.status}`);
  process.exit(2);
}
const available = new Set(((await res.json()).data ?? []).map((m) => m.id));

let bad = 0;
for (const id of wanted) {
  const ok = available.has(id);
  if (!ok) bad++;
  console.log(`${ok ? "ok     " : "MISSING"} ${id}${id === defaultModel ? "   (default)" : ""}`);
}

console.log(`\n${wanted.length} ids checked against ${available.size} available.`);
if (bad > 0) {
  console.error(`${bad} invalid — fix the preset in src/db/db.ts.`);
  process.exit(1);
}
console.log("All preset model ids exist.");
