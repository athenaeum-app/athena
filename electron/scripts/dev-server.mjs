// Runs the Go server for dev. Builds to a stable path (server/athena-server[.exe],
// already in .gitignore) instead of using `go run`, which compiles to a fresh
// random temp path on every launch. On Windows that made Defender Firewall
// treat it as a new app each time and re-prompt for network access on every
// `npm run dev`. Building to the same path each time means Windows only asks
// once.

import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(scriptDir, '../../server')
const bin = path.join(serverDir, process.platform === 'win32' ? 'athena-server.exe' : 'athena-server')

const build = spawnSync('go', ['build', '-o', bin, './cmd/athena-server'], {
    cwd: serverDir,
    stdio: 'inherit',
})
if (build.status !== 0) {
    process.exit(build.status ?? 1)
}

const child = spawn(bin, [], { cwd: serverDir, stdio: 'inherit' })

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig))
}

child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
})
