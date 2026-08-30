import { fileURLToPath, URL } from 'node:url'
import { execSync } from 'node:child_process'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from "vite-plugin-singlefile"

/**
 * Identifies the exact bundle a browser is running, for the version line in the
 * account menu. The Leither app version cannot serve that purpose: it is
 * assigned by tweet1.sh after the build, and each node reports its own view of
 * it, so a node can serve this bundle while naming a different version.
 * The commit is what the build came from; the timestamp separates rebuilds of
 * the same commit, and "+" marks a build made from an uncommitted tree.
 */
function buildId(): string {
  let commit = 'nogit'
  try {
    const git = (cmd: string) =>
      execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    commit = git('git rev-parse --short HEAD')
    if (git('git status --porcelain')) commit += '+'
  } catch {
    // Built outside a git checkout; the timestamp alone still identifies it.
  }
  const t = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${commit} ${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}`
}

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId())
  },
  plugins: [vue({
    template: {
      compilerOptions: {
        isCustomElement: (tag) => ['video-js', 'qr-code'].includes(tag)    // video-js is custom component
      }
    }
  }),
    viteSingleFile({inlinePattern: ["*.css"]}),
    {
      name: 'leither-entry-path',
      enforce: 'post',
      transformIndexHtml(html) {
        // Leither resolves entry object names literally and does not accept
        // Vite 8's leading "./" on generated local asset paths.
        return html
          .replace('src="./hprose.js"', 'src="hprose.js"')
          .replace('src="./popper.min.js"', 'src="popper.min.js"')
          .replace('src="./bootstrap.min.js"', 'src="bootstrap.min.js"')
          .replace('src="./index_entry.js"', 'src="index_entry.js"')
      }
    },
    // removeConsole({ includes: ["log"]})
  ],
  build: {
    assetsDir: '.',   // create ONE layer directory structure
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        entryFileNames: "index_entry.js"
      }
    }
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    proxy: {
    },
    cors: false,
    headers: {
      'Content-Security-Policy': "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' 'inline-speculation-rules' chrome-extension://12f15d28-93bc-4657-af5b-e610e459ad52/ https://www.googletagmanager.com https://www.google-analytics.com; object-src 'none';"
    }
  },
})
