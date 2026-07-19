import { execFileSync } from "node:child_process";

const minimum = [0, 16, 0];
let version = "";

try {
  version = execFileSync("zig", ["version"], { encoding: "utf8" }).trim();
} catch {
  console.error("zero-native requires Zig 0.16.0 or newer, but no zig binary was found on PATH.");
  process.exit(1);
}

if (!isAtLeast(version, minimum)) {
  console.error(`zero-native requires Zig 0.16.0 or newer. Found Zig ${version}.`);
  console.error("Install a newer Zig, then rerun npm run native:build or npm run native:run.");
  process.exit(1);
}

console.log(`Zig ${version} is compatible with zero-native.`);

function isAtLeast(value, min) {
  const parts = value.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return false;
  for (let index = 0; index < min.length; index += 1) {
    if ((parts[index] ?? 0) > min[index]) return true;
    if ((parts[index] ?? 0) < min[index]) return false;
  }
  return true;
}
