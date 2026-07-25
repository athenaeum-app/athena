// True when the PWA is running inside the Athena Electron shell rather than
// a normal browser tab. The shell's window has no OS title bar (see
// electron/src/main.js), so UI that depends on that (drag regions, space
// reserved for the window control overlay) is gated on this.
export const isElectron = navigator.userAgent.includes('Electron')
