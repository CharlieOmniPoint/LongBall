import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("apps/api/dist", { recursive: true });
await build({
  entryPoints: {
    api: "apps/api/src/main.ts",
    worker: "apps/worker/src/main.ts",
  },
  outdir: "apps/api/dist",
  outExtension: { ".js": ".mjs" },
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  external: ["sharp"],
  logLevel: "info",
});
await copyFile(
  "apps/api/src/media-worker.mjs",
  "apps/api/dist/media-worker.mjs",
);
