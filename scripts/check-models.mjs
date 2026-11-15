import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const model = "VersionHistory";
const text = (path) => readFileSync(path, "utf8");
const setup = (source) => source.split(/^INVARIANTS?\s*$/m)[0].trimEnd();
const invariants = (source) => source.split(/^INVARIANTS?\s*$/m)[1].trim().split(/\s+/);
const expected = JSON.parse(text("spec/broken/EXPECTED.json"));
const source = text(`spec/${model}.tla`);
const config = text(`spec/${model}.cfg`);
const variants = readdirSync("spec/broken").filter((name) => name.endsWith(".cfg")).map((name) => name.slice(0, -4));
assert.deepEqual(variants.sort(), Object.keys(expected).sort());
for (const invariant of invariants(config).filter((name) => name !== "TypeOK")) {
  assert(Object.values(expected).some((entry) => entry.invariant === invariant), `No broken variant covers ${invariant}`);
}
for (const [name, { invariant }] of Object.entries(expected)) {
  const brokenConfig = text(`spec/broken/${name}.cfg`);
  assert.deepEqual(invariants(brokenConfig), [invariant], `${name} must check exactly its intended invariant`);
  assert.equal(setup(brokenConfig), setup(config), `${name} must use the same bounds`);
  const normalized = source.replace(`MODULE ${model}`, `MODULE ${name}`);
  const delta = spawnSync("diff", ["-", `spec/broken/${name}.tla`], { input: normalized, encoding: "utf8" });
  assert.equal(delta.status, 1, `${name} must differ from the correct model`);
  const changed = delta.stdout.split("\n").filter((line) => /^[<>]/.test(line)).length;
  assert(changed >= 1 && changed <= 6, `${name} must represent one small mistake`);
}
const result = spawnSync(process.execPath, ["scripts/tlc.mjs"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
assert.equal(result.status, 0, "The kit TLC runner must pass every model and catch every broken variant");
const counts = [...result.stdout.matchAll(/found no error in (\d+) states/g)].map((match) => Number(match[1]));
assert(counts.length > 0 && counts.every((count) => count > 1000), "The model must explore more than 1000 distinct states");
process.stdout.write("Model structure: every invariant has a bounded, one-mistake counterexample.\n");
