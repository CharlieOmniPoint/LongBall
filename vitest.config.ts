import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Node tests cover pure adapter cores; do not resolve Expo's mobile-only tsconfig through Vite.
  tsconfig: './tsconfig.json',
  test: {
    include: ['packages/**/*.test.ts', 'apps/mobile/src/platform/**/*.test.ts'],
    maxWorkers: 2,
  },
});
