// Frees a TCP port before `npm run dev` starts. The dev runner uses
// `concurrently -k`, which kills every sibling process the moment one exits.
// So if a previous dev run left a stray Vite server squatting on 5173 (e.g. the
// terminal was closed before Vite released the port), the new client fails with
// "Port 5173 is already in use", exits, and `-k` tears down the server and
// Electron too. Running this first makes the port reliably available.
//
// Usage: node scripts/free-port.mjs [port]   (defaults to 5173)

import { spawnSync } from 'node:child_process'

const port = Number(process.argv[2] ?? 5173)

function pidsOnPort(p) {
    if (process.platform === 'win32') {
        // netstat is available on every Windows install; -ano gives numeric
        // addresses + owning PID. Match LISTENING rows whose local address ends
        // in :<port> so we don't catch outbound connections to the same number.
        const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? ''
        const pids = new Set()
        for (const line of out.split(/\r?\n/)) {
            const cols = line.trim().split(/\s+/)
            if (cols.length >= 5 && cols[3] === 'LISTENING' && cols[1].endsWith(`:${p}`)) {
                pids.add(cols[4])
            }
        }
        return [...pids]
    }
    // macOS / Linux: lsof prints one PID per line for listening sockets.
    const out = spawnSync('lsof', ['-ti', `tcp:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? ''
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

const pids = pidsOnPort(port)
if (pids.length === 0) {
    console.log(`Port ${port} is free.`)
    process.exit(0)
}

for (const pid of pids) {
    console.log(`Freeing port ${port}: killing stale process ${pid}.`)
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' })
    } else {
        try {
            process.kill(Number(pid), 'SIGKILL')
        } catch {
            // Already gone between listing and killing, so nothing to do.
        }
    }
}
