import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import tailwindcss from '@tailwindcss/vite'
import solid from 'vite-plugin-solid'
import { resolve } from 'path'
import { readFileSync } from 'fs'

// Expose the app version (from package.json) to the client as a compile-time
// constant, so the top bar can show "Athena v{version}" the way v1 did.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [
        solid(),
        tailwindcss(),
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['favicon.svg'],
            workbox: {
                // Default navigateFallback ('index.html') has no denylist, so
                // the service worker was intercepting *every* top-level
                // navigation (including the backup-download <a href> link,
                // a plain browser navigation to /api/v1/backups/.../download)
                // and serving the cached app shell instead of letting the
                // request reach the network/server. Exclude /api/ so direct
                // navigations to API routes (downloads) pass through.
                navigateFallbackDenylist: [/^\/api\//],
            },
            manifest: {
                name: 'Athena',
                short_name: 'Athena',
                description: 'A self-hosted journaling and archiving app',
                theme_color: '#1a1a2e',
                background_color: '#1a1a2e',
                display: 'standalone',
                start_url: '/',
                icons: [
                    {
                        src: '/icon-192.png',
                        sizes: '192x192',
                        type: 'image/png',
                    },
                    {
                        src: '/icon-512.png',
                        sizes: '512x512',
                        type: 'image/png',
                    },
                ],
            },
        }),
    ],
    build: {
        outDir: resolve(__dirname, '../server/client/web'),
        emptyOutDir: true,
    },
    server: {
        host: '127.0.0.1',
        // The Electron dev shell (electron/scripts) waits on and hardcodes
        // this exact port. If it's taken (e.g. a stale dev server left over
        // from an ungracefully-killed previous `npm run dev`), Vite must fail
        // loudly rather than silently moving to 5174. Otherwise Electron
        // connects to whatever's still on 5173 (or hangs waiting on it
        // forever) instead of the server that's actually running.
        port: 5173,
        strictPort: true,
        proxy: {
            '/api': 'http://localhost:8080',
        },
    },
})
