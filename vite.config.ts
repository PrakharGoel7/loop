import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'loop-store-revision-without-call-reload',
      hotUpdate({ file, modules, timestamp }) {
        if (!file.replaceAll('\\', '/').includes('/src/store/')) return
        // Store revisions are published mid-call. A normal HMR update propagates
        // through App and reloads the interview tab, which ends the study and
        // immediately reverts the revision. Invalidate server transforms so a
        // deliberate store reload sees the new source, but send no HMR event.
        const invalidated = new Set<(typeof modules)[number]>()
        for (const module of modules) {
          this.environment.moduleGraph.invalidateModule(module, invalidated, timestamp, true)
        }
        return []
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
})
