import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from "vite-plugin-singlefile"

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue({
    template: {
      compilerOptions: {
        isCustomElement: (tag) => ['video-js', 'qr-code'].includes(tag)    // video-js is custom component
      }
    }
  }),
    viteSingleFile({inlinePattern: ["*.css"]}),
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
