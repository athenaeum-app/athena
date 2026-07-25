// Preload for the modal overlay view (modal-overlay.html).
//
// The add-/remove-library modals cannot live in shell.html: Electron always
// composites a child WebContentsView (the active server's embedded PWA) ABOVE
// the host BrowserWindow's DOM, so a shell-DOM modal renders *behind* the open
// library and is invisible. The modals therefore live in their own transparent
// WebContentsView that the main process stacks on top of the content view when
// a modal opens. This bridge is the overlay's only channel to main.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlay', {
    // main -> overlay: which modal to show, with any payload (remove target).
    // Returns an unsubscribe function.
    onShow: (cb) => {
        const h = (_e, payload) => cb(payload)
        ipcRenderer.on('overlay:show', h)
        return () => ipcRenderer.removeListener('overlay:show', h)
    },
    // main -> overlay: the active library's resolved theme palette (or null to
    // reset to the dark defaults), so the modal themes itself to match the open
    // library instead of always rendering with its own hard-coded defaults.
    onTheme: (cb) => {
        const h = (_e, palette) => cb(palette)
        ipcRenderer.on('overlay:theme', h)
        return () => ipcRenderer.removeListener('overlay:theme', h)
    },
    // overlay -> main: dismiss without acting (cancel / backdrop / Escape).
    close: () => ipcRenderer.invoke('overlay:close'),
    // overlay -> main: commit an add. Main persists the profile, hides the
    // overlay, tells the shell to refresh, and opens the new library.
    submitAdd: (name, url) => ipcRenderer.invoke('overlay:addSubmit', name, url),
    // overlay -> main: commit a removal. Main deletes the profile, hides the
    // overlay, and tells the shell to refresh.
    submitRemove: (id) => ipcRenderer.invoke('overlay:removeSubmit', id),
})
