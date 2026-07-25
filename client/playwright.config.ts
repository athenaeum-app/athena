import { defineConfig, devices } from '@playwright/test'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { rmSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// The E2E suite drives the real Go server (with the embedded PWA) end to end.
// Before running, build both artifacts from athenaeum/:
//
//   cd client && npm run build                     # PWA -> server/client/web
//   cd server && go build -o athena-server.exe ./cmd/athena-server
//
// Then: cd client && npm run e2e
//
// The server binary is launched by Playwright's webServer below against a
// throwaway data directory that is wiped on every run so the first-user
// (owner) registration always starts from a clean slate.

const PORT = 8099
const dataDir = resolve(__dirname, 'e2e', '.data')

// Wipe the throwaway data dir once, in the main runner process, before the
// webServer is spawned, guaranteeing a fresh "needs setup" server each run.
// Worker processes (which re-import this config while the server holds the
// DB open) must NOT attempt the delete, or it fails with EPERM on Windows.
if (!process.env.TEST_WORKER_INDEX) {
    try {
        rmSync(dataDir, { recursive: true, force: true })
    } catch {
        // Best effort: a stale lock shouldn't abort the whole run.
    }
}

const serverBin =
    process.platform === 'win32'
        ? resolve(__dirname, '..', 'server', 'athena-server.exe')
        : resolve(__dirname, '..', 'server', 'athena-server')

export default defineConfig({
    testDir: './e2e',
    timeout: 30_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    use: {
        baseURL: `http://localhost:${PORT}`,
        headless: true,
        trace: 'on-first-retry',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: {
        command: `"${serverBin}"`,
        port: PORT,
        reuseExistingServer: false,
        timeout: 30_000,
        env: {
            PORT: String(PORT),
            DB_PATH: resolve(dataDir, 'athena.db'),
            UPLOADS_PATH: resolve(dataDir, 'uploads'),
            SESSION_EXPIRY_DAYS: '30',
        },
    },
})
