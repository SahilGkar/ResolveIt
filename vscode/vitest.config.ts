import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./tests/vscode-mock.ts', import.meta.url)),
    },
  },
});
