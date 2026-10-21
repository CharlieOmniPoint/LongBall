import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('.local/runtime', { recursive: true });
await build({
  entryPoints: ['scripts/runtime-worker.ts'],
  outfile: '.local/runtime/worker-proof.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['pg', 'sharp'],
  alias: {
    '@longball/domain': resolve('packages/domain/src/index.ts'),
    '@longball/testing': resolve('packages/testing/src/index.ts'),
  },
});
