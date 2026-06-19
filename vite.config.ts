import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { devFs } from '@immediately-run/dev-fs';

// The agent's filesystem tools (src/lib/fsTools.ts) `import fs from 'fs'`. That
// `fs` is host-provided at runtime (ZenFS in the sandbox); devFs() backs it with
// the local disk under `vite dev`, and we externalize `fs`/`node:fs` from the
// production build so immediately.run resolves it from its runtime instead of
// Vite trying to bundle a Node builtin. https://vite.dev/config/
export default defineConfig({
  plugins: [react(), devFs()],
  build: {
    rollupOptions: { external: ['fs', 'node:fs'] },
  },
});
