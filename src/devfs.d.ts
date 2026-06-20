// Pull in the `fs` module types provided by @immediately-run/dev-fs, so app
// code can `import fs from 'fs'` and type-check against the async-only surface
// immediately.run exposes (ZenFS in the sandbox; the dev-fs bridge under local
// `vite dev`). The agent's filesystem tools (lib/fsTools.ts) read/write through
// it. See https://github.com/immediately-run/dev-fs
/// <reference types="@immediately-run/dev-fs/fs" />
