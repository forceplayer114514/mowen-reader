import { resolve } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'),
      'translation-worker': resolve('src/main/translation-worker.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts'), 'online-site': resolve('src/preload/online-site.ts') },
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
    plugins: [react(), {
      name: 'local-pdf-resources',
      configureServer(server) {
        server.middlewares.use('/pdf-assets', (req, res, next) => {
          const match = /^\/(cmaps|standard_fonts|wasm)\/([\w.-]+)$/.exec((req.url ?? '').split('?')[0])
          if (!match) return next()
          try {
            res.setHeader('Content-Type', match[2].endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
            res.end(readFileSync(resolve('node_modules/pdfjs-dist', match[1], match[2])))
          } catch { next() }
        })
      },
      generateBundle() {
        for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
          for (const name of readdirSync(resolve('node_modules/pdfjs-dist', dir))) {
            if (!/\.(bcmap|ttf|pfb|wasm)$/.test(name)) continue
            this.emitFile({ type: 'asset', fileName: `pdf-assets/${dir}/${name}`, source: readFileSync(resolve('node_modules/pdfjs-dist', dir, name)) })
          }
        }
      }
    }]
  }
})
