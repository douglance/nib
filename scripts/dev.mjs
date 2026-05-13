import { spawn } from "node:child_process";
import process from "node:process";

const env = {
  ...process.env,
  HOST: process.env.HOST ?? "0.0.0.0",
  PORT: process.env.PORT ?? "4070",
  CLIENT_PORT: process.env.CLIENT_PORT ?? "4071",
  NODE_ENV: "development"
};

const children = [
  spawn("npx", ["tsx", "src/server/index.ts"], { env, stdio: "inherit" }),
  spawn("npx", ["vite", "--host", "127.0.0.1", "--port", env.CLIENT_PORT, "--strictPort"], {
    env,
    stdio: "inherit"
  })
];

const stop = (signal) => {
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
};

process.on("SIGINT", () => {
  stop("SIGINT");
  process.exit(130);
});

process.on("SIGTERM", () => {
  stop("SIGTERM");
  process.exit(143);
});

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      stop("SIGTERM");
      process.exit(code);
    }
  });
}
