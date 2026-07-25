// Wipes the Electron launcher's persisted state: the electron-store config
// holding server profiles, lastServerId, and the per-server theme map. This
// is the dev counterpart to `reset:server` (which wipes the Go server's data
// dir). It recomputes the electron-store config path exactly as Electron does
// (app.getPath('userData') = appData + app name), so it runs without launching
// Electron.
//
// This must match main.js's dev-only userData override (`app.isPackaged`
// check) so it wipes the dev store, NOT a real installed app's. The two used
// to share one directory, so this script could nuke a real install's config.

import { rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Must match the Electron app name (electron/package.json "name"), which is
// what app.getPath('userData') derives the store directory from in dev.
const APP_NAME = 'athena-client'

function appDataDir() {
    switch (process.platform) {
        case 'win32':
            return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
        case 'darwin':
            return path.join(os.homedir(), 'Library', 'Application Support')
        default:
            return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    }
}

const configFile = path.join(appDataDir(), APP_NAME + ' (dev)', 'config.json')
rmSync(configFile, { force: true })
console.log('Reset launcher state:', configFile)
