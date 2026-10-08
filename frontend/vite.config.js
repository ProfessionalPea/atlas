import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function atlasBrowserDialogBridge() {
  return {
    name: 'atlas-browser-dialog-bridge',
    enforce: 'pre',
    transform(code, id) {
      const normalizedId = id.replace(/\\/g, '/')
      if (!normalizedId.endsWith('/src/App.jsx')) return null

      let next = code

      // App.jsx predates the shared Atlas feedback surface. Keep this bridge
      // deliberately narrow so every remaining native browser confirm/alert is
      // rendered by Atlas itself without a risky large-file rewrite.
      next = next.replace(
        'const handleReset = () => {',
        'const handleReset = async () => {'
      )
      next = next.replace(/window\.confirm\(/g, 'await window.__atlasConfirm(')
      next = next.replace(/(?<![\w$.])alert\(/g, 'window.__atlasAlert(')

      if (/window\.confirm\(|(?<![\w$.])alert\(/.test(next)) {
        throw new Error('Atlas browser-dialog bridge left a native prompt in App.jsx')
      }

      return { code: next, map: null }
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [atlasBrowserDialogBridge(), react()],
})
