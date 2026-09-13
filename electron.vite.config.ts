import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        output: {
          // The sandboxed preload loader cannot parse ESM `import` syntax, and
          // package.json has "type": "module" so a plain `.js` extension would
          // still be loaded as ESM. Force CommonJS output with a `.cjs`
          // extension, which Node/Electron always treats as CommonJS.
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name]-[hash].cjs'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
    resolve: {
      alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer') }
    },
    plugins: [react()]
  }
})
