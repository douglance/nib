import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = Number(process.env.PORT ?? 4070);
const clientPort = Number(process.env.CLIENT_PORT ?? 4071);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: clientPort,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/api": `http://127.0.0.1:${serverPort}`,
      "/screenshots": `http://127.0.0.1:${serverPort}`,
      "/p": {
        target: `http://127.0.0.1:${serverPort}`,
        ws: true
      }
    }
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  }
});
