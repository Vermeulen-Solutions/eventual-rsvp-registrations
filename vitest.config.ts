import { defineConfig } from 'vitest/config';
import { emdashPluginTest } from '@emdash-cms/plugin-test/config';

export default defineConfig({
  plugins: [emdashPluginTest()],
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 60000,
    hookTimeout: 180000,
  },
});
