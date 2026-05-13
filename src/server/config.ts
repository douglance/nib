import path from "node:path";

export const HOST = process.env.HOST ?? "0.0.0.0";
export const PORT = Number(process.env.PORT ?? 4070);
export const CLIENT_PORT = Number(process.env.CLIENT_PORT ?? 4071);
export const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? "https://doug-mm.tail5d92b4.ts.net";
export const LOCAL_BASE_URL = process.env.LOCAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;
export const TAILSCALE_HOSTNAME = process.env.TAILSCALE_HOSTNAME ?? "doug-mm.tail5d92b4.ts.net";
export const TAILSCALE_IP = process.env.TAILSCALE_IP ?? "100.68.227.98";

export const DATA_DIR = process.env.PRTL_DATA_DIR ?? path.join(process.cwd(), ".prtl");
export const SCREENSHOT_DIR = path.join(DATA_DIR, "screenshots");
export const ARTIFACT_DIR = path.join(DATA_DIR, "artifacts");

export const ignoredPorts = new Set([
  9222,
  9229,
  11434,
  27036,
  27060,
  49152,
  6463,
  PORT,
  CLIENT_PORT
]);

export const ignoredCommandFragments = [
  "Google Chrome",
  "Discord",
  "Steam",
  "rapportd",
  "ollama",
  "ControlCenter",
  "Elgato",
  "Logi",
  "Raycast",
  "OrbStack",
  "/bin/codex",
  "/vendor/aarch64-apple-darwin/codex",
  "node -e require('node:http')",
  "scripts/terminal-bridge.mjs"
];
