import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";

const outdir = resolve(process.env.LONGBALL_API_BUILD_DIRECTORY ?? "apps/api/dist");
if (outdir !== resolve("apps/api/dist") && !outdir.startsWith(resolve(".local") + sep)) {
  throw new Error("Use the standard API export directory or an isolated build under .local.");
}
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: {
    api: "apps/api/src/main.ts",
    worker: "apps/worker/src/main.ts",
    migrate: "apps/api/src/migrate.ts",
    "report-pdf-probe": "apps/api/src/report-export-pdf-probe.ts",
  },
  outdir,
  outExtension: { ".js": ".mjs" },
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  alias: {
    "@longball/domain": resolve("packages/domain/src/index.ts"),
    "@longball/testing": resolve("packages/testing/src/index.ts"),
  },
  external: ["sharp", "pg", "fastify"],
  logLevel: "info",
});
await copyFile(
  "apps/api/src/media-worker.mjs",
  resolve(outdir, "media-worker.mjs"),
);
await copyFile("apps/api/src/heic-worker.mjs",resolve(outdir,"heic-worker.mjs"));
const fontDirectory = resolve(outdir, "assets/fonts");
await mkdir(fontDirectory, { recursive: true });
for (const filename of ["DejaVuSans.ttf", "LICENSE"]) {
  await copyFile(
    resolve("apps/api/src/assets/fonts", filename),
    resolve(fontDirectory, filename),
  );
}
