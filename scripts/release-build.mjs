import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./build.mjs";

const root = join(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = `ambitious-compliance-${version}.mjs`;
const output = join(root, "release");
mkdirSync(output, { recursive: true });
copyFileSync(join(root, "dist", "ambitious-compliance.mjs"), join(output, name));
chmodSync(join(output, name), 0o755);
const hash = createHash("sha256").update(readFileSync(join(output, name))).digest("hex");
writeFileSync(join(output, "SHA256SUMS"), `${hash}  ${name}\n`);
process.stdout.write(`Release ${version} built in release/:\n${hash}  ${name}\n`);
