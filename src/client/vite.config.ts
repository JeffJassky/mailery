import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  base: '/admin/mailer/_assets/',
  build: {
    outDir: path.resolve(__dirname, '../../dist/admin/spa'),
    emptyOutDir: true,
    assetsDir: '.',
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/admin/mailer/api': 'http://localhost:3000',
    },
  },
})
