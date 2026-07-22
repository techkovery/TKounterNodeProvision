const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tkProvision', {
    quitApp: () => ipcRenderer.invoke('app:quit'),
    getSavedConfig: () => ipcRenderer.invoke('config:get'),
    saveConfig: (config) => ipcRenderer.invoke('config:set', config),
    login: (payload) => ipcRenderer.invoke('auth:login', payload),
    discoverNodes: (payload) => ipcRenderer.invoke('node:discover', payload),
    inspectNode: (payload) => ipcRenderer.invoke('node:inspect', payload),
    provisionNode: (payload) => ipcRenderer.invoke('node:provision', payload),
    onProvisionProgress: (handler) => {
        const listener = (_, event) => handler(event)
        ipcRenderer.on('provision:progress', listener)
        return () => ipcRenderer.removeListener('provision:progress', listener)
    }
})
