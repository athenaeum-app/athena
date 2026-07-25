// Preload script for the shell chrome (shell.html). Exposes a minimal,
// explicit IPC API to the persistent sidebar / welcome page. The embedded PWA
// itself uses a separate, narrower preload (content-preload.cjs).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('athena', {
    // Server profiles
    listServers: () => ipcRenderer.invoke('servers:list'),
    getActiveServer: () => ipcRenderer.invoke('servers:getActive'),
    addServer: (name, url) => ipcRenderer.invoke('servers:add', name, url),
    renameServer: (id, name) => ipcRenderer.invoke('servers:rename', id, name),
    removeServer: (id) => ipcRenderer.invoke('servers:remove', id),
    openServer: (id) => ipcRenderer.invoke('servers:open', id),
    reorderServers: (orderedIds) => ipcRenderer.invoke('servers:reorder', orderedIds),
    getServerThemes: () => ipcRenderer.invoke('servers:getThemes'),
    setServerTheme: (id, themeId) => ipcRenderer.invoke('servers:setTheme', id, themeId),

    // Persistent-rail chrome controls
    setRailCollapsed: (collapsed) => ipcRenderer.invoke('ui:setRailCollapsed', collapsed),

    // Modal overlay: the add-/remove-library modals render in a separate
    // top-stacked view (they can't paint over the embedded library from here),
    // so the shell just asks main to open them.
    openAddModal: () => ipcRenderer.invoke('ui:openModal', { type: 'add' }),
    openRemoveModal: (id, name) => ipcRenderer.invoke('ui:openModal', { type: 'remove', id, name }),

    // Main -> shell notifications. Each returns an unsubscribe function.
    onActiveChanged: (cb) => {
        const h = (_e, id) => cb(id)
        ipcRenderer.on('servers:active-changed', h)
        return () => ipcRenderer.removeListener('servers:active-changed', h)
    },
    onServerStatus: (cb) => {
        const h = (_e, payload) => cb(payload)
        ipcRenderer.on('servers:status', h)
        return () => ipcRenderer.removeListener('servers:status', h)
    },
    onServersChanged: (cb) => {
        const h = () => cb()
        ipcRenderer.on('servers:changed', h)
        return () => ipcRenderer.removeListener('servers:changed', h)
    },
    onToggleRail: (cb) => {
        const h = () => cb()
        ipcRenderer.on('ui:toggle-rail', h)
        return () => ipcRenderer.removeListener('ui:toggle-rail', h)
    },
    onExpandRail: (cb) => {
        const h = () => cb()
        ipcRenderer.on('ui:expand-rail', h)
        return () => ipcRenderer.removeListener('ui:expand-rail', h)
    },
    // Active server's resolved theme palette (or null to reset to defaults),
    // so the sidebar chrome can theme itself to match the open library.
    onServerTheme: (cb) => {
        const h = (_e, palette) => cb(palette)
        ipcRenderer.on('servers:theme', h)
        return () => ipcRenderer.removeListener('servers:theme', h)
    },
})
