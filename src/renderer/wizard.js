const WIZARD_STATE_KEY = 'tkounter-provision-wizard'

const pageFiles = {
    config: 'config.html',
    discover: 'discover.html',
    credentials: 'credentials.html',
    provision: 'provision.html',
    complete: 'complete.html'
}

const defaultState = {
    token: '',
    userId: '',
    apiBaseUrl: 'https://techkovery.eu',
    wsUrl: 'ws://nodes.techkovery.eu/ws',
    nodesRuntimeUrl: 'https://nodes.techkovery.eu',
    serverName: 'techkovery.eu',
    adminUser: '',
    adminPassword: '',
    nodeName: '',
    nodeHost: '',
    nodeUser: 'root',
    nodePassword: '',
    inspectedNode: null,
    provision: {
        started: false,
        completed: false,
        failed: false,
        progress: 0,
        currentMessage: '',
        logs: [],
        result: null,
        error: ''
    }
}

const progressRules = [
    { pattern: /Preparing node/i, value: 12 },
    { pattern: /Reading node metadata/i, value: 28 },
    { pattern: /Registering node/i, value: 48 },
    { pattern: /Assigned tunnel port/i, value: 62 },
    { pattern: /Writing tunnel script/i, value: 76 },
    { pattern: /Installing bootstrap/i, value: 88 },
    { pattern: /Provisioning completed/i, value: 100 }
]

function loadState() {
    try {
        const raw = window.sessionStorage.getItem(WIZARD_STATE_KEY)
        if (!raw) return structuredClone(defaultState)
        return mergeState(structuredClone(defaultState), JSON.parse(raw))
    } catch {
        return structuredClone(defaultState)
    }
}

function mergeState(base, patch) {
    const merged = { ...base, ...patch }
    merged.provision = { ...base.provision, ...(patch?.provision || {}) }
    return merged
}

function saveState(state) {
    window.sessionStorage.setItem(WIZARD_STATE_KEY, JSON.stringify(state))
}

function appendProvisionLog(state, message) {
    const now = new Date().toLocaleTimeString()
    state.provision.logs.push(`[${now}] ${message}`)
    state.provision.currentMessage = message

    for (const rule of progressRules) {
        if (rule.pattern.test(message)) {
            state.provision.progress = Math.max(state.provision.progress, rule.value)
        }
    }

    saveState(state)
}

function resetProvisionState(state) {
    state.provision = {
        started: false,
        completed: false,
        failed: false,
        progress: 0,
        currentMessage: '',
        logs: [],
        result: null,
        error: ''
    }
    saveState(state)
}

function goTo(screen) {
    window.location.href = `./${pageFiles[screen]}`
}

function byId(id) {
    return document.getElementById(id)
}

function setBanner(element, message, tone = 'neutral') {
    element.textContent = message
    element.dataset.tone = tone
}

function setBusy(button, busy, labelBusy) {
    if (!button) return
    if (!button.dataset.labelDefault) {
        button.dataset.labelDefault = button.textContent
    }

    button.disabled = busy
    button.textContent = busy ? labelBusy : button.dataset.labelDefault
}

function renderLogs(element, logs) {
    element.textContent = logs.join('\n')
    element.scrollTop = element.scrollHeight
}

function guardState(state, requiredScreen) {
    if (requiredScreen === 'discover' && !state.token) goTo('config')
    if (requiredScreen === 'credentials' && !state.nodeHost) goTo('discover')
    if (requiredScreen === 'provision' && (!state.nodeHost || !state.nodePassword || !state.nodeName || !state.token)) goTo('credentials')
    if (requiredScreen === 'complete' && !state.provision.result && !state.provision.error) goTo('provision')
}

async function hydratePersistentConfig(state) {
    const cfg = await window.tkProvision.getSavedConfig()
    state.apiBaseUrl = cfg.apiBaseUrl || state.apiBaseUrl
    state.wsUrl = cfg.wsUrl || state.wsUrl
    state.nodesRuntimeUrl = cfg.nodesRuntimeUrl || state.nodesRuntimeUrl
    state.serverName = cfg.serverName || state.serverName
    state.adminUser = cfg.adminUser || state.adminUser
    state.adminPassword = cfg.adminPassword || state.adminPassword
    saveState(state)
}

const ENVIRONMENTS = {
    local: {
        label: 'Local (Oficina)',
        description: 'Red local, para pruebas',
        fixed: {
            apiBaseUrl: 'https://192.168.1.100:3001',
            wsUrl: 'ws://192.168.1.100:9001',
            nodesRuntimeUrl: 'https://192.168.1.100:4001',
            serverName: '192.168.1.100'
        }
    },
    dev: {
        label: 'Desarrollo',
        description: 'dev.techkovery.eu',
        fixed: {
            apiBaseUrl: 'https://dev.techkovery.eu',
            wsUrl: 'ws://nodes-dev.techkovery.eu/ws',
            nodesRuntimeUrl: 'https://nodes-dev.techkovery.eu',
            serverName: 'techkovery.eu'
        }
    },
    prod: {
        label: 'Producción',
        description: 'techkovery.eu',
        fixed: {
            apiBaseUrl: 'https://techkovery.eu',
            wsUrl: 'ws://nodes.techkovery.eu/ws',
            nodesRuntimeUrl: 'https://nodes.techkovery.eu',
            serverName: 'techkovery.eu'
        }
    }
}

function setupConfigScreen(state) {
    const ui = {
        envGrid: byId('envGrid'),
        envSummary: byId('envSummary'),
        envSummaryTitle: byId('envSummaryTitle'),
        editEnvBtn: byId('editEnvBtn'),
        sumApiBaseUrl: byId('sumApiBaseUrl'),
        sumWsUrl: byId('sumWsUrl'),
        sumNodesRuntimeUrl: byId('sumNodesRuntimeUrl'),
        sumServerName: byId('sumServerName'),
        credentialsPanel: byId('credentialsPanel'),
        adminUser: byId('adminUser'),
        adminPassword: byId('adminPassword'),
        configStatus: byId('configStatus'),
        connectBtn: byId('connectBtn'),
        modalBackdrop: byId('editModalBackdrop'),
        modalApiBaseUrl: byId('modalApiBaseUrl'),
        modalWsUrl: byId('modalWsUrl'),
        modalNodesRuntimeUrl: byId('modalNodesRuntimeUrl'),
        modalServerName: byId('modalServerName'),
        closeModalBtn: byId('closeModalBtn'),
        cancelModalBtn: byId('cancelModalBtn'),
        saveModalBtn: byId('saveModalBtn')
    }

    let currentEnv = null
    let currentValues = null

    ui.adminUser.value = state.adminUser || ''
    ui.adminPassword.value = state.adminPassword || ''

    const updateConnectAvailability = () => {
        const ready = Boolean(currentValues && ui.adminUser.value.trim() && ui.adminPassword.value)
        ui.connectBtn.disabled = !ready
    }

    const renderSummary = () => {
        ui.sumApiBaseUrl.textContent = currentValues.apiBaseUrl
        ui.sumWsUrl.textContent = currentValues.wsUrl
        ui.sumNodesRuntimeUrl.textContent = currentValues.nodesRuntimeUrl
        ui.sumServerName.textContent = currentValues.serverName
        ui.envSummaryTitle.textContent = `Entorno: ${ENVIRONMENTS[currentEnv].label}`
        ui.envSummary.classList.remove('hidden')
        ui.credentialsPanel.classList.remove('hidden')
    }

    const selectEnv = (envId) => {
        currentEnv = envId
        ui.envGrid.querySelectorAll('.env-card').forEach((card) => {
            card.classList.toggle('selected', card.dataset.env === envId)
        })

        currentValues = { ...ENVIRONMENTS[envId].fixed }
        renderSummary()
        setBanner(ui.configStatus, 'Revisa los parámetros e introduce las credenciales', 'neutral')
        updateConnectAvailability()
    }

    ui.envGrid.querySelectorAll('.env-card').forEach((card) => {
        card.addEventListener('click', () => selectEnv(card.dataset.env))
    })

    ui.editEnvBtn.addEventListener('click', () => {
        ui.modalApiBaseUrl.value = currentValues.apiBaseUrl
        ui.modalWsUrl.value = currentValues.wsUrl
        ui.modalNodesRuntimeUrl.value = currentValues.nodesRuntimeUrl
        ui.modalServerName.value = currentValues.serverName
        ui.modalBackdrop.classList.remove('hidden')
    })

    const closeModal = () => ui.modalBackdrop.classList.add('hidden')
    ui.closeModalBtn.addEventListener('click', closeModal)
    ui.cancelModalBtn.addEventListener('click', closeModal)
    ui.modalBackdrop.addEventListener('click', (event) => {
        if (event.target === ui.modalBackdrop) closeModal()
    })

    ui.saveModalBtn.addEventListener('click', () => {
        const next = {
            apiBaseUrl: ui.modalApiBaseUrl.value.trim(),
            wsUrl: ui.modalWsUrl.value.trim(),
            nodesRuntimeUrl: ui.modalNodesRuntimeUrl.value.trim(),
            serverName: ui.modalServerName.value.trim()
        }

        if (!next.apiBaseUrl || !next.wsUrl || !next.nodesRuntimeUrl || !next.serverName) {
            setBanner(ui.configStatus, 'Completa todos los campos antes de guardar', 'warning')
            return
        }

        if (!/^ws:\/\//i.test(next.wsUrl)) {
            setBanner(ui.configStatus, 'La WS URL debe empezar por ws://', 'warning')
            return
        }

        currentValues = next
        renderSummary()
        closeModal()
        updateConnectAvailability()
    })

    ui.adminUser.addEventListener('input', updateConnectAvailability)
    ui.adminPassword.addEventListener('input', updateConnectAvailability)

    ui.connectBtn.addEventListener('click', async () => {
        try {
            if (!currentValues) {
                throw new Error('Selecciona un entorno primero')
            }

            const adminUser = ui.adminUser.value.trim()
            const adminPassword = ui.adminPassword.value
            if (!adminUser || !adminPassword) {
                throw new Error('Introduce usuario y contraseña de administrador')
            }

            const next = {
                apiBaseUrl: currentValues.apiBaseUrl,
                wsUrl: currentValues.wsUrl,
                nodesRuntimeUrl: currentValues.nodesRuntimeUrl,
                serverName: currentValues.serverName,
                adminUser,
                adminPassword
            }

            setBusy(ui.connectBtn, true, 'Conectando...')
            await window.tkProvision.saveConfig(next)
            const auth = await window.tkProvision.login({
                apiBaseUrl: next.apiBaseUrl,
                username: next.adminUser,
                password: next.adminPassword
            })

            if (!auth.isAdmin) {
                throw new Error('El usuario autenticado no es administrador')
            }

            Object.assign(state, next, { token: auth.token, userId: String(auth.userId || '') })
            resetProvisionState(state)
            saveState(state)
            goTo('discover')
        } catch (error) {
            setBanner(ui.configStatus, `Error de conexión: ${error.message}`, 'danger')
        } finally {
            setBusy(ui.connectBtn, false, 'Conectando...')
        }
    })

    updateConnectAvailability()
}

function setupDiscoverScreen(state) {
    guardState(state, 'discover')

    const ui = {
        serverSummary: byId('serverSummary'),
        discoverBtn: byId('discoverBtn'),
        manualContinueBtn: byId('manualContinueBtn'),
        manualIp: byId('manualIp'),
        discoverStatus: byId('discoverStatus'),
        discoverMeta: byId('discoverMeta'),
        discoverResults: byId('discoverResults'),
        backBtn: byId('backBtn')
    }

    ui.serverSummary.innerHTML = `
        <strong>${state.apiBaseUrl}</strong>
        <span>WS URL: ${state.wsUrl}</span>
        <span>Nodes runtime: ${state.nodesRuntimeUrl}</span>
        <span>Tunnel server: ${state.serverName}</span>
        <span>Admin: ${state.adminUser}</span>
    `
    ui.manualIp.value = state.nodeHost || ''

    const selectHost = (host) => {
        state.nodeHost = host.ip
        state.inspectedNode = null
        state.nodePassword = ''
        state.nodeName = ''
        resetProvisionState(state)
        saveState(state)
        setBanner(ui.discoverStatus, `Node selected: ${host.ip}`, 'success')
        window.setTimeout(() => goTo('credentials'), 250)
    }

    ui.discoverBtn.addEventListener('click', async () => {
        try {
            setBusy(ui.discoverBtn, true, 'Scanning...')
            setBanner(ui.discoverStatus, 'Scanning for GL.iNet routers that respond to HTTP RPC...', 'neutral')
            ui.discoverMeta.textContent = 'Scanning...'
            ui.discoverResults.innerHTML = ''
            const result = await window.tkProvision.discoverNodes({})

            if (!result.hosts.length) {
                ui.discoverMeta.textContent = '0 results'
                setBanner(ui.discoverStatus, 'No GL.iNet routers were found through RPC. Try manual IP.', 'warning')
                return
            }

            ui.discoverMeta.textContent = `${result.hosts.length} GL.iNet node(s)`
            for (const host of result.hosts) {
                const item = document.createElement('button')
                item.type = 'button'
                item.className = 'host-item'
                item.innerHTML = `
                    <div class="host-item-main">
                        <strong>${host.ip}</strong>
                        <span>${host.hostname} · ${host.model}</span>
                    </div>
                    <div class="host-item-side">
                        <span>fw ${host.firmwareVersion}</span>
                        <span class="host-ssh ${host.sshReachable ? 'ok' : 'warn'}">${host.sshReachable ? 'SSH reachable' : 'SSH unreachable'}</span>
                    </div>
                `
                item.addEventListener('click', () => selectHost(host))
                ui.discoverResults.appendChild(item)
            }

            setBanner(ui.discoverStatus, 'Select one of the detected GL.iNet routers or use manual IP.', 'success')
        } catch (error) {
            setBanner(ui.discoverStatus, `Discovery error: ${error.message}`, 'danger')
            ui.discoverMeta.textContent = 'Error'
        } finally {
            setBusy(ui.discoverBtn, false, 'Scanning...')
        }
    })

    ui.manualContinueBtn.addEventListener('click', () => {
        const host = ui.manualIp.value.trim()
        if (!host) {
            setBanner(ui.discoverStatus, 'Enter a manual IP or hostname.', 'warning')
            return
        }

        selectHost({ ip: host })
    })

    ui.backBtn.addEventListener('click', () => goTo('config'))
}

function setupCredentialsScreen(state) {
    guardState(state, 'credentials')

    const ui = {
        selectedHostLabel: byId('selectedHostLabel'),
        nodeHost: byId('nodeHost'),
        nodeName: byId('nodeName'),
        nodeUser: byId('nodeUser'),
        nodePassword: byId('nodePassword'),
        inspectBtn: byId('inspectBtn'),
        continueBtn: byId('continueBtn'),
        inspectStatus: byId('inspectStatus'),
        infoName: byId('infoName'),
        infoHostname: byId('infoHostname'),
        infoMac: byId('infoMac'),
        infoFirmware: byId('infoFirmware'),
        infoState: byId('infoState'),
        infoUuid: byId('infoUuid'),
        backBtn: byId('backBtn')
    }

    ui.selectedHostLabel.textContent = state.nodeHost
    ui.nodeHost.value = state.nodeHost
    ui.nodeName.value = state.nodeName || ''
    ui.nodeUser.value = state.nodeUser || 'root'
    ui.nodePassword.value = state.nodePassword || ''

    const fillInspection = (info) => {
        ui.infoName.textContent = info?.nodeName || '-'
        ui.infoHostname.textContent = info?.hostname || '-'
        ui.infoMac.textContent = info?.mac || '-'
        ui.infoFirmware.textContent = info?.firmwareVersion || '-'
        ui.infoState.textContent = info?.state || '-'
        ui.infoUuid.textContent = info?.uuid || '-'
    }

    fillInspection(state.inspectedNode)
    if (state.inspectedNode) {
        ui.continueBtn.disabled = false
        setBanner(ui.inspectStatus, `Node inspected: ${state.inspectedNode.hostname}`, 'success')
    }

    ui.inspectBtn.addEventListener('click', async () => {
        try {
            const payload = {
                host: ui.nodeHost.value.trim(),
                username: ui.nodeUser.value.trim() || 'root',
                password: ui.nodePassword.value
            }

            if (!payload.host) {
                throw new Error('Provide node host or IP')
            }

            setBusy(ui.inspectBtn, true, 'Inspecting...')
            const info = await window.tkProvision.inspectNode(payload)
            state.nodeHost = payload.host
            state.nodeUser = payload.username
            state.nodePassword = payload.password
            state.nodeName = ui.nodeName.value.trim()
            state.inspectedNode = info
            resetProvisionState(state)
            saveState(state)
            fillInspection(info)
            if (!ui.nodeName.value.trim() && info?.nodeName) {
                ui.nodeName.value = info.nodeName
                state.nodeName = info.nodeName
                saveState(state)
            }
            ui.continueBtn.disabled = false
            setBanner(ui.inspectStatus, `Node ready: ${info.hostname} | ${info.state}`, 'success')
        } catch (error) {
            ui.continueBtn.disabled = true
            setBanner(ui.inspectStatus, `Inspection error: ${error.message}`, 'danger')
        } finally {
            setBusy(ui.inspectBtn, false, 'Inspecting...')
        }
    })

    ui.continueBtn.addEventListener('click', () => {
        state.nodeHost = ui.nodeHost.value.trim()
        state.nodeName = ui.nodeName.value.trim()
        state.nodeUser = ui.nodeUser.value.trim() || 'root'
        state.nodePassword = ui.nodePassword.value

        if (!state.nodeName) {
            setBanner(ui.inspectStatus, 'Name is required before provisioning', 'warning')
            return
        }

        if (!/^[a-zA-Z0-9 _.-]{1,64}$/.test(state.nodeName)) {
            setBanner(ui.inspectStatus, 'Name can only include letters, numbers, spaces, dot, underscore and hyphen (max 64)', 'warning')
            return
        }

        saveState(state)
        goTo('provision')
    })

    ui.backBtn.addEventListener('click', () => goTo('discover'))
}

function renderProvisionUi(state, ui) {
    ui.progressBar.style.width = `${state.provision.progress}%`
    ui.progressPercent.textContent = `${state.provision.progress}%`
    ui.progressLabel.textContent = state.provision.currentMessage || 'Ready to start'
    renderLogs(ui.logOutput, state.provision.logs)

    if (state.provision.completed) {
        setBanner(ui.provisionStatus, 'Provisioning completed successfully', 'success')
        ui.finishBtn.classList.remove('hidden')
    } else if (state.provision.failed) {
        setBanner(ui.provisionStatus, `Provisioning failed: ${state.provision.error}`, 'danger')
        ui.finishBtn.classList.add('hidden')
    } else if (state.provision.started) {
        setBanner(ui.provisionStatus, 'Provisioning in progress...', 'neutral')
        ui.finishBtn.classList.add('hidden')
    } else {
        setBanner(ui.provisionStatus, 'Pending', 'neutral')
        ui.finishBtn.classList.add('hidden')
    }
}

function setupProvisionScreen(state) {
    guardState(state, 'provision')

    const ui = {
        provisionSummary: byId('provisionSummary'),
        progressBar: byId('progressBar'),
        progressLabel: byId('progressLabel'),
        progressPercent: byId('progressPercent'),
        provisionStatus: byId('provisionStatus'),
        logOutput: byId('logOutput'),
        retryBtn: byId('retryBtn'),
        startProvisionBtn: byId('startProvisionBtn'),
        finishBtn: byId('finishBtn'),
        backBtn: byId('backBtn')
    }

    ui.provisionSummary.textContent = `Name ${state.nodeName} | host ${state.nodeHost} | admin ${state.adminUser} | node ${state.inspectedNode?.hostname || 'no hostname'}`
    renderProvisionUi(state, ui)

    const unsubscribe = window.tkProvision.onProvisionProgress((event) => {
        appendProvisionLog(state, event.message)
        renderProvisionUi(state, ui)
    })

    const runProvision = async () => {
        try {
            resetProvisionState(state)
            state.provision.started = true
            state.provision.progress = 4
            appendProvisionLog(state, `Starting provisioning for ${state.nodeHost}`)
            renderProvisionUi(state, ui)
            setBusy(ui.startProvisionBtn, true, 'Provisioning...')
            ui.backBtn.disabled = true

            const result = await window.tkProvision.provisionNode({
                host: state.nodeHost,
                name: state.nodeName,
                username: state.nodeUser,
                password: state.nodePassword,
                apiBaseUrl: state.apiBaseUrl,
                wsUrl: state.wsUrl,
                nodesRuntimeUrl: state.nodesRuntimeUrl,
                token: state.token,
                serverName: state.serverName
            })

            state.provision.started = false
            state.provision.completed = true
            state.provision.failed = false
            state.provision.progress = 100
            state.provision.result = result
            appendProvisionLog(state, `Suggested SSH command: ${result.defaultSshAccess}`)
            saveState(state)
            renderProvisionUi(state, ui)
        } catch (error) {
            state.provision.started = false
            state.provision.completed = false
            state.provision.failed = true
            state.provision.error = error.message
            appendProvisionLog(state, `Error: ${error.message}`)
            saveState(state)
            renderProvisionUi(state, ui)
        } finally {
            setBusy(ui.startProvisionBtn, false, 'Provisioning...')
            ui.backBtn.disabled = false
        }
    }

    ui.startProvisionBtn.addEventListener('click', runProvision)
    ui.retryBtn.addEventListener('click', runProvision)
    ui.finishBtn.addEventListener('click', () => goTo('complete'))
    ui.backBtn.addEventListener('click', () => goTo('credentials'))

    window.addEventListener('beforeunload', () => {
        if (typeof unsubscribe === 'function') unsubscribe()
    })
}

function setupCompleteScreen(state) {
    guardState(state, 'complete')

    const ui = {
        completeTitle: byId('completeTitle'),
        completeSubtitle: byId('completeSubtitle'),
        completeStatus: byId('completeStatus'),
        summaryHost: byId('summaryHost'),
        summaryUuid: byId('summaryUuid'),
        summaryPort: byId('summaryPort'),
        summaryAccess: byId('summaryAccess'),
        finalLogOutput: byId('finalLogOutput'),
        restartBtn: byId('restartBtn'),
        againBtn: byId('againBtn')
    }

    const result = state.provision.result
    if (result) {
        ui.completeTitle.textContent = 'Provisioning completed'
        ui.completeSubtitle.textContent = 'The node was registered and base services were deployed.'
        setBanner(ui.completeStatus, 'Completed successfully', 'success')
        ui.summaryHost.textContent = state.nodeHost || '-'
        ui.summaryUuid.textContent = result.nodeUuid || state.inspectedNode?.uuid || '-'
        ui.summaryPort.textContent = String(result.tunnelPort || '-')
        ui.summaryAccess.textContent = result.defaultSshAccess || '-'
    } else {
        ui.completeTitle.textContent = 'Provisioning interrupted'
        ui.completeSubtitle.textContent = 'The last run ended with an error. You can retry from credentials.'
        setBanner(ui.completeStatus, state.provision.error || 'No result', 'danger')
        ui.summaryHost.textContent = state.nodeHost || '-'
        ui.summaryUuid.textContent = state.inspectedNode?.uuid || '-'
        ui.summaryPort.textContent = '-'
        ui.summaryAccess.textContent = '-'
    }

    renderLogs(ui.finalLogOutput, state.provision.logs)

    ui.restartBtn.addEventListener('click', () => {
        state.nodeHost = ''
        state.nodeName = ''
        state.nodePassword = ''
        state.inspectedNode = null
        resetProvisionState(state)
        saveState(state)
        goTo('discover')
    })

    ui.againBtn.addEventListener('click', () => {
        resetProvisionState(state)
        saveState(state)
        goTo('credentials')
    })
}

async function main() {
    const screen = document.body.dataset.screen
    const state = loadState()
    await hydratePersistentConfig(state)

    if (screen === 'config') setupConfigScreen(state)
    if (screen === 'discover') setupDiscoverScreen(state)
    if (screen === 'credentials') setupCredentialsScreen(state)
    if (screen === 'provision') setupProvisionScreen(state)
    if (screen === 'complete') setupCompleteScreen(state)

    if (typeof feather !== 'undefined') {
        feather.replace()
    }
}

main().catch((error) => {
    const fallback = document.body.querySelector('.status-banner')
    if (fallback) {
        fallback.textContent = `Error initializing screen: ${error.message}`
        fallback.dataset.tone = 'danger'
    }
})