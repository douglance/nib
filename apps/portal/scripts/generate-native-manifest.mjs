import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const nativeDir = path.join(root, "native");
const templatePath = path.join(nativeDir, "app.template.zon");
const manifestPath = path.join(nativeDir, "app.zon");
const originsPath = path.join(nativeDir, "src", "allowed_origins.zig");

const baseOrigins = new Set([
  "zero://app",
  "zero://inline",
  "http://127.0.0.1:4070",
  "http://127.0.0.1:*",
  "http://localhost:4070",
  "http://localhost:*",
  "http://[::1]:*",
  "http://127.0.0.1:5173",
  "http://localhost:5173"
]);

for (const origin of await discoverOrigins()) baseOrigins.add(origin);

const origins = [...baseOrigins].sort((a, b) => a.localeCompare(b));
const zonOrigins = origins.map((origin) => `                "${escapeZon(origin)}"`).join(",\n");
const template = await fs.readFile(templatePath, "utf8");
await fs.writeFile(manifestPath, template.replace('                "__ALLOWED_ORIGINS__"', zonOrigins), "utf8");
await fs.writeFile(
  originsPath,
  `pub const allowed_origins = [_][]const u8{\n${origins.map((origin) => `    "${escapeZon(origin)}",`).join("\n")}\n};\n`,
  "utf8"
);

console.log(`Generated native/app.zon with ${origins.length} allowed origins.`);

async function discoverOrigins() {
  const origins = new Set();
  let payload = null;
  try {
    const response = await fetch("http://127.0.0.1:4070/api/projects?refresh=1", {
      signal: AbortSignal.timeout(1800)
    });
    if (response.ok) payload = await response.json();
  } catch {
    return origins;
  }

  if (payload?.publicBaseUrl) addUrlOrigin(origins, payload.publicBaseUrl);
  const projects = Array.isArray(payload?.projects) ? payload.projects : [];
  for (const project of projects) {
    if (project?.targetKind === "local-app" && Number.isFinite(project.port)) {
      origins.add(`http://127.0.0.1:${project.port}`);
      origins.add(`http://localhost:${project.port}`);
      continue;
    }
    addUrlOrigin(origins, project?.url);
    addUrlOrigin(origins, project?.directUrl);
    addUrlOrigin(origins, project?.openPath);
    for (const route of Object.values(project?.routes ?? {})) {
      addUrlOrigin(origins, route?.url);
    }
  }
  return origins;
}

function addUrlOrigin(origins, value) {
  if (!value || typeof value !== "string" || value.startsWith("/")) return;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") origins.add(url.origin);
  } catch {
    // Ignore non-URL route values.
  }
}

function escapeZon(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
