// Electron shell: keeps the existing headless Express service (src/server.js)
// running in the background, exposed to the user only via a tray icon.
const { app, Tray, Menu, nativeImage, clipboard, Notification, shell } = require('electron')
const fs = require('fs')
const path = require('path')

const PROTOCOL = 'tkounter-provision'
// Must live under desktop/ (not build/): "build/" is only used by
// electron-builder itself to make the installer/exe icon, it isn't packaged
// into the app, so loading it at runtime would silently yield an empty icon.
// The .ico bundles multiple resolutions (16/32/48/256px) - Windows only
// (nativeImage docs), used for the tray/notifications there.
const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico')
// Plain PNG fallback for platforms that can't load .ico via nativeImage.
const TRAY_PNG_PATH = path.join(__dirname, 'assets', 'tray-icon.png')

// Only one instance may bind to the service port at a time.
if (!app.requestSingleInstanceLock()) {
    app.quit()
    process.exit(0)
}

app.setAppUserModelId('eu.techkovery.tkounter-node-provision')
if (!app.isDefaultProtocolClient(PROTOCOL)) {
    app.setAsDefaultProtocolClient(PROTOCOL)
}

let tray = null
let config = null
let cfg = null
let serviceError = null

function notify(title, body) {
    if (!Notification.isSupported()) return
    const icon = process.platform === 'win32' ? ICON_PATH : TRAY_PNG_PATH
    new Notification({ title, body, icon }).show()
}

function startService() {
    try {
        config = require('../src/config')
        const isFirstRun = !fs.existsSync(config.CONFIG_FILE)
        cfg = config.load()
        require('../src/server') // side effect: binds 127.0.0.1:4783

        // Default to autostart on the very first launch only; afterwards the
        // user's choice from the tray menu checkbox is respected as-is.
        if (isFirstRun) {
            app.setLoginItemSettings({ openAtLogin: true })
        }
    } catch (err) {
        serviceError = err
        console.error('Failed to start TKounter Node Provision service:', err)
    }
}

function buildMenu() {
    const loginSettings = app.getLoginItemSettings()
    const port = process.env.PORT || 4783
    const statusLabel = serviceError
        ? `Error al iniciar (ver logs): ${serviceError.message}`
        : `Escuchando en 127.0.0.1:${port}`

    return Menu.buildFromTemplate([
        { label: 'TKounter Node Provision', enabled: false },
        { label: statusLabel, enabled: false },
        { type: 'separator' },
        {
            label: 'Copiar pairing token',
            enabled: !serviceError && !!cfg,
            click: () => {
                clipboard.writeText(cfg.pairingToken)
                notify('TKounter Node Provision', 'Pairing token copiado al portapapeles')
            }
        },
        {
            label: 'Abrir carpeta de configuración',
            enabled: !!config,
            click: () => shell.showItemInFolder(config.CONFIG_FILE)
        },
        { type: 'separator' },
        {
            label: 'Iniciar con Windows',
            type: 'checkbox',
            checked: loginSettings.openAtLogin,
            click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked })
        },
        { type: 'separator' },
        { label: 'Reiniciar aplicación', click: () => { app.relaunch(); app.exit(0) } },
        { label: 'Salir', click: () => app.quit() }
    ])
}

function refreshTray() {
    if (!tray) return
    tray.setContextMenu(buildMenu())
    tray.setToolTip(serviceError ? 'TKounter Node Provision (error)' : 'TKounter Node Provision')
}

function createTray() {
    // On Windows, load every resolution embedded in the .ico as-is and let
    // the shell pick the right one for the current DPI scale factor; forcing
    // a single resized bitmap here (e.g. to 16x16) makes the tray icon blurry
    // on high-DPI/scaled displays.
    const icon = process.platform === 'win32'
        ? nativeImage.createFromPath(ICON_PATH)
        : nativeImage.createFromPath(TRAY_PNG_PATH).resize({ width: 32, height: 32 })
    tray = new Tray(icon)
    tray.setToolTip('TKounter Node Provision')
    tray.on('click', () => tray.popUpContextMenu())
    refreshTray()
}

function handleProtocolInvocation(argv) {
    const launchedViaProtocol = argv.some((arg) => arg.startsWith(`${PROTOCOL}://`))
    if (launchedViaProtocol) {
        notify('TKounter Node Provision', 'El servicio ya está activo, puedes continuar en el navegador')
    }
}

app.on('second-instance', (_event, argv) => {
    handleProtocolInvocation(argv)
    if (tray) tray.popUpContextMenu()
})

app.whenReady().then(() => {
    startService()
    createTray()
    handleProtocolInvocation(process.argv)
})

app.on('window-all-closed', (event) => event.preventDefault())
