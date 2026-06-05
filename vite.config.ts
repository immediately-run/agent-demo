import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The contribute dialog — a first-party immediately.run system app
// (UI_AS_APPS_SPEC §5.1). It streams a save of the user's edits (PR or direct
// commit) via the elevated `contribute()` SDK call. https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
});
