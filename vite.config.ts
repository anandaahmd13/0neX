import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// Gateway dev target — dipakai proxy agar dashboard bicara same-origin.
// Cookie sesi httpOnly hanya bekerja same-origin, dan ini menghindari
// menaruh token admin apa pun di bundle browser.
const GATEWAY_TARGET = process.env.VITE_GATEWAY_HTTP_URL ?? 'http://localhost:8788'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5199,
    strictPort: true,
    proxy: {
      '/admin': { target: GATEWAY_TARGET, changeOrigin: true },
      '/v1': { target: GATEWAY_TARGET, changeOrigin: true },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
