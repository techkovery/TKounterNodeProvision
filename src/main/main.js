const path = require('path')
const { app, BrowserWindow, ipcMain, Menu } = require('electron')
const electronStoreModule = require('electron-store')
const { discoverNodes, inspectNode, authLogin, runProvisioning } = require('./provisioningService')

const Store = electronStoreModule.default || electronStoreModule
const isDevelopment = !app.isPackaged || process.env.NODE_ENV === 'development'

const store = new Store({
    name: 'tkounter-node-provision',
    defaults: {
        apiBaseUrl: 'https://techkovery.eu',
        wsUrl: 'ws://nodes.techkovery.eu/ws',
        nodesRuntimeUrl: 'https://nodes.techkovery.eu',
        serverName: 'techkovery.eu',
        adminUser: '',
        adminPassword: ''
    }
})

function createWindow() {
    const win = new BrowserWindow({
        width: 1120,
        height: 760,
        minWidth: 1120,
        minHeight: 760,
        maxWidth: 1120,
        maxHeight: 760,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    })

    win.removeMenu()
    win.loadFile(path.join(__dirname, '..', 'renderer', 'config.html'))

    if (isDevelopment) {
        win.webContents.once('did-finish-load', () => {
            if (!win.isDestroyed()) {
                win.webContents.openDevTools({ mode: 'detach' })
            }
        })
    }
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    createWindow()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('app:quit', () => {
    app.quit()
    return { ok: true }
})

ipcMain.handle('config:get', () => {
    const saved = store.store
    return {
        apiBaseUrl: saved.apiBaseUrl,
        wsUrl: saved.wsUrl,
        nodesRuntimeUrl: saved.nodesRuntimeUrl,
        serverName: saved.serverName,
        adminUser: saved.adminUser,
        adminPassword: saved.adminPassword
    }
})

ipcMain.handle('config:set', (_, config) => {
    const allowed = ['apiBaseUrl', 'wsUrl', 'nodesRuntimeUrl', 'serverName', 'adminUser', 'adminPassword']
    for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(config, key)) {
            store.set(key, String(config[key] || '').trim())
        }
    }
    return { ok: true }
})

ipcMain.handle('auth:login', async (_, payload) => {
    const result = await authLogin({
        apiBaseUrl: payload.apiBaseUrl,
        username: payload.username,
        password: payload.password
    })

    store.set('adminUser', payload.username)
    store.set('adminPassword', payload.password)
    return {
        token: result.token,
        userId: result.userId,
        role: result.role,
        isAdmin: result.isAdmin
    }
})

ipcMain.handle('node:discover', async (_, payload = {}) => {
    const hosts = await discoverNodes(payload)
    return { hosts }
})

ipcMain.handle('node:inspect', async (_, payload) => {
    return inspectNode(payload)
})

ipcMain.handle('node:provision', async (event, payload) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender)
    const send = (message) => {
        if (browserWindow && !browserWindow.isDestroyed()) {
            browserWindow.webContents.send('provision:progress', {
                at: new Date().toISOString(),
                message
            })
        }
    }

    return runProvisioning({
        host: payload.host,
        name: payload.name,
        username: payload.username,
        password: payload.password,
        apiBaseUrl: payload.apiBaseUrl,
        wsUrl: payload.wsUrl,
        nodesRuntimeUrl: payload.nodesRuntimeUrl,
        token: payload.token,
        serverName: payload.serverName,
        onProgress: send
    })
})
