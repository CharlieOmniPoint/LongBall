import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['apps/api/src/**/*.test.ts', 'apps/worker/src/**/*.test.ts', 'packages/application/src/access.test.ts'], maxWorkers: 2 } });
