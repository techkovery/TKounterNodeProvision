const state = {
    token: '',
    apiBaseUrl: 'https://techkovery.eu',
    serverName: 'techkovery.eu',
    updatesBaseUrl: 'https://updates.techkovery.eu',
    updatesApp: 'tkounter',
    updatesFlavor: 'techkovery'
}

const ui = {
    apiBaseUrl: document.getElementById('apiBaseUrl'),
    adminUser: document.getElementById('adminUser'),
    adminPassword: document.getElementById('adminPassword'),
    saveConfigBtn: document.getElementById('saveConfigBtn'),
    loginBtn: document.getElementById('loginBtn'),
    authStatus: document.getElementById('authStatus'),

    discoverBtn: document.getElementById('discoverBtn'),
    manualIp: document.getElementById('manualIp'),
    discoverResults: document.getElementById('discoverResults'),

    nodeHost: document.getElementById('nodeHost'),
    nodeUser: document.getElementById('nodeUser'),
    nodePassword: document.getElementById('nodePassword'),
    inspectBtn: document.getElementById('inspectBtn'),
    provisionBtn: document.getElementById('provisionBtn'),
    nodeStatus: document.getElementById('nodeStatus'),

    logOutput: document.getElementById('logOutput')
}

function appendLog(message) {
    const now = new Date().toLocaleTimeString()
    ui.logOutput.textContent += `[${now}] ${message}\n`
    ui.logOutput.scrollTop = ui.logOutput.scrollHeight
}

function setAuthStatus(text, ok = false) {
    ui.authStatus.textContent = text
    ui.authStatus.style.color = ok ? '#1f6f4a' : '#665f57'
}

function setNodeStatus(text, ok = false) {
    ui.nodeStatus.textContent = text
    ui.nodeStatus.style.color = ok ? '#1f6f4a' : '#665f57'
}

async function loadConfig() {
    const cfg = await window.tkProvision.getSavedConfig()
    state.apiBaseUrl = cfg.apiBaseUrl || state.apiBaseUrl
    state.serverName = cfg.serverName || state.serverName
    state.updatesBaseUrl = cfg.updatesBaseUrl || state.updatesBaseUrl
    state.updatesApp = cfg.updatesApp || state.updatesApp
    state.updatesFlavor = cfg.updatesFlavor || state.updatesFlavor

    ui.apiBaseUrl.value = state.apiBaseUrl
    ui.adminUser.value = cfg.adminUser || ''
}

ui.saveConfigBtn.addEventListener('click', async () => {
    state.apiBaseUrl = ui.apiBaseUrl.value.trim() || state.apiBaseUrl
    await window.tkProvision.saveConfig({
        apiBaseUrl: state.apiBaseUrl,
        serverName: state.serverName,
        updatesBaseUrl: state.updatesBaseUrl,
        updatesApp: state.updatesApp,
        updatesFlavor: state.updatesFlavor,
        adminUser: ui.adminUser.value.trim()
    })
    appendLog(`Configuration saved: ${state.apiBaseUrl}`)
})

ui.loginBtn.addEventListener('click', async () => {
    try {
        const username = ui.adminUser.value.trim()
        const password = ui.adminPassword.value

        if (!username || !password) {
            throw new Error('Enter user and password')
        }

        const auth = await window.tkProvision.login({
            apiBaseUrl: ui.apiBaseUrl.value.trim(),
            username,
            password
        })

        if (!auth.isAdmin) {
            throw new Error('Authenticated user is not admin')
        }

        state.token = auth.token
        setAuthStatus(`Authenticated as admin (userId=${auth.userId})`, true)
        appendLog('Login OK')
    } catch (error) {
        setAuthStatus(`Login error: ${error.message}`, false)
        appendLog(`Login error: ${error.message}`)
    }
})

ui.discoverBtn.addEventListener('click', async () => {
    try {
        appendLog('Scanning local network (port 22)...')
        ui.discoverResults.innerHTML = ''
        const result = await window.tkProvision.discoverNodes({})

        if (!result.hosts.length) {
            appendLog('No hosts with open SSH were found.')
            return
        }

        for (const host of result.hosts) {
            const li = document.createElement('li')
            const btn = document.createElement('button')
            btn.textContent = `Use ${host}`
            btn.addEventListener('click', () => {
                ui.nodeHost.value = host
                appendLog(`Selected host: ${host}`)
            })
            li.textContent = `${host} `
            li.appendChild(btn)
            ui.discoverResults.appendChild(li)
        }

        appendLog(`Discovery completed: ${result.hosts.length} host(s)`)
    } catch (error) {
        appendLog(`Discovery error: ${error.message}`)
    }
})

ui.manualIp.addEventListener('change', () => {
    const host = ui.manualIp.value.trim()
    if (host) {
        ui.nodeHost.value = host
        appendLog(`Manual IP set: ${host}`)
    }
})

ui.inspectBtn.addEventListener('click', async () => {
    try {
        const payload = {
            host: ui.nodeHost.value.trim(),
            username: ui.nodeUser.value.trim() || 'root',
            password: ui.nodePassword.value
        }

        if (!payload.host) throw new Error('Provide host/IP')

        const info = await window.tkProvision.inspectNode(payload)
        setNodeStatus(`Status: ${info.state}. UUID: ${info.uuid || '(no uuid)'}`, info.state !== 'unknown')
        appendLog(`Node: host=${payload.host}, mac=${info.mac}, hostname=${info.hostname}, fw=${info.firmwareVersion}`)
    } catch (error) {
        setNodeStatus(`Error: ${error.message}`, false)
        appendLog(`Inspection error: ${error.message}`)
    }
})

ui.provisionBtn.addEventListener('click', async () => {
    try {
        if (!state.token) {
            throw new Error('You must log in as admin before provisioning')
        }

        const payload = {
            host: ui.nodeHost.value.trim(),
            username: ui.nodeUser.value.trim() || 'root',
            password: ui.nodePassword.value,
            apiBaseUrl: ui.apiBaseUrl.value.trim(),
            token: state.token,
            serverName: state.serverName,
            updatesBaseUrl: state.updatesBaseUrl,
            updatesApp: state.updatesApp,
            updatesFlavor: state.updatesFlavor
        }

        if (!payload.host) throw new Error('Provide node host/IP')

        appendLog(`Starting provisioning for ${payload.host}`)
        const result = await window.tkProvision.provisionNode(payload)
        setNodeStatus(`Provisioned OK - UUID ${result.nodeUuid} - port ${result.tunnelPort}`, true)
        appendLog(`Done. Suggested access: ${result.defaultSshAccess}`)
    } catch (error) {
        setNodeStatus(`Provisioning failed: ${error.message}`, false)
        appendLog(`Provisioning error: ${error.message}`)
    }
})

window.tkProvision.onProvisionProgress((event) => {
    appendLog(event.message)
})

loadConfig().catch((error) => {
    appendLog(`Error loading initial configuration: ${error.message}`)
})
