// VS Code API
const vscode = acquireVsCodeApi();

// DOM Elements
let setupBtn, refreshStatusBtn, settingsBtn, detectBoardsBtn, logsBtn;
let progressSection, progressBar, progressText, progressStage, progressPercentage;
let boardsList;
let debugSection, debugHaltBtn, debugResumeBtn, debugStepBtn, debugStopBtn;
let registersList, memoryViewer, stackViewer;
let memoryAddressInput, memorySizeInput, memoryReadBtn;
let statusCards = {};
let debugTabs = [];
let currentDebugTab = 'registers';

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    initializeElements();
    attachEventListeners();
    requestStatus();
    
    // Send ready message to extension
    vscode.postMessage({ command: 'ready' });
    console.log('Port11 Debugger webview initialized');
});

function initializeElements() {
    // Action buttons
    setupBtn = document.getElementById('setup-btn');
    refreshStatusBtn = document.getElementById('refresh-status-btn');
    settingsBtn = document.getElementById('settings-btn');
    detectBoardsBtn = document.getElementById('detect-boards-btn');
    logsBtn = document.getElementById('logs-btn');
    
    // Progress elements
    progressSection = document.getElementById('setup-progress');
    progressBar = document.getElementById('progress-bar');
    progressText = document.getElementById('progress-text');
    progressStage = document.getElementById('progress-stage');
    progressPercentage = document.getElementById('progress-percentage');
    
    // Lists
    boardsList = document.getElementById('boards-list');
    
    // Debug elements
    debugSection = document.getElementById('debug-section');
    debugHaltBtn = document.getElementById('debug-halt-btn');
    debugResumeBtn = document.getElementById('debug-resume-btn');
    debugStepBtn = document.getElementById('debug-step-btn');
    debugStopBtn = document.getElementById('debug-stop-btn');
    
    registersList = document.getElementById('registers-list');
    memoryViewer = document.getElementById('memory-viewer');
    stackViewer = document.getElementById('stack-viewer');
    
    memoryAddressInput = document.getElementById('memory-address');
    memorySizeInput = document.getElementById('memory-size');
    memoryReadBtn = document.getElementById('memory-read-btn');
    
    // Status cards
    statusCards = {
        sdk: {
            card: document.getElementById('sdk-status'),
            icon: document.getElementById('sdk-icon'),
            details: document.getElementById('sdk-details'),
            version: document.getElementById('sdk-version')
        },
        toolchain: {
            card: document.getElementById('toolchain-status'),
            icon: document.getElementById('toolchain-icon'),
            details: document.getElementById('toolchain-details'),
            version: document.getElementById('toolchain-version')
        },
        sysconfig: {
            card: document.getElementById('sysconfig-status'),
            icon: document.getElementById('sysconfig-icon'),
            details: document.getElementById('sysconfig-details'),
            version: document.getElementById('sysconfig-version')
        },
        debugger: {
            card: document.getElementById('debugger-status'),
            icon: document.getElementById('debugger-icon'),
            details: document.getElementById('debugger-details'),
            version: document.getElementById('debugger-version')
        }
    };
    
    // Debug tabs
    debugTabs = document.querySelectorAll('.debug-tab');
}

function attachEventListeners() {
    // Setup actions
    if (setupBtn) {
        setupBtn.addEventListener('click', () => {
            console.log('Setup button clicked');
            vscode.postMessage({ command: 'startSetup' });
        });
    }
    
    if (refreshStatusBtn) {
        refreshStatusBtn.addEventListener('click', () => {
            console.log('Refresh status clicked');
            requestStatus();
        });
    }
    
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            console.log('Settings button clicked');
            vscode.postMessage({ command: 'openSettings' });
        });
    }
    
    if (detectBoardsBtn) {
        detectBoardsBtn.addEventListener('click', () => {
            console.log('Detect boards clicked');
            vscode.postMessage({ command: 'detectBoards' });
        });
    }
    
    if (logsBtn) {
        logsBtn.addEventListener('click', () => {
            console.log('Logs button clicked');
            vscode.postMessage({ command: 'showLogs' });
        });
    }
    
    // Debug controls
    if (debugHaltBtn) {
        debugHaltBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'debugHalt' });
        });
    }
    
    if (debugResumeBtn) {
        debugResumeBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'debugResume' });
        });
    }
    
    if (debugStepBtn) {
        debugStepBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'debugStep' });
        });
    }
    
    if (debugStopBtn) {
        debugStopBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'debugStop' });
        });
    }
    
    // Memory viewer
    if (memoryReadBtn) {
        memoryReadBtn.addEventListener('click', () => {
            const address = memoryAddressInput.value;
            const size = parseInt(memorySizeInput.value) || 64;
            
            if (address) {
                vscode.postMessage({ 
                    command: 'readMemory',
                    address: address,
                    size: size
                });
            }
        });
    }
    
    // Debug tabs
    debugTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            switchDebugTab(tab.getAttribute('data-tab'));
        });
    });
    
    // Listen for messages from extension
    window.addEventListener('message', handleMessage);
}

function handleMessage(event) {
    const message = event.data;
    console.log('📨 Received message:', message.command);
    
    switch (message.command) {
        case 'updateStatus':
            updateSystemStatus(message.data);
            break;
        case 'setupProgress':
            updateSetupProgress(message.data);
            break;
        case 'setupComplete':
            hideProgress();
            updateFooterStatus('Setup complete!');
            requestStatus();
            break;
        case 'setupError':
            hideProgress();
            updateFooterStatus('Setup failed');
            showError(message.data.error);
            break;
        case 'boardsDetected':
            updateBoardsList(message.data.boards);
            break;
        case 'debugSessionStarted':
            showDebugSection();
            break;
        case 'debugSessionStopped':
            hideDebugSection();
            break;
        case 'registersUpdate':
            updateRegisters(message.data.registers);
            break;
        case 'memoryData':
            updateMemoryViewer(message.data);
            break;
        case 'error':
            showError(message.data.message);
            break;
    }
}

function requestStatus() {
    vscode.postMessage({ command: 'getStatus' });
    updateFooterStatus('Checking status...');
}

// Status updates
function updateSystemStatus(status) {
    if (status.sdk) {
        updateComponentStatus('sdk', status.sdk);
    }
    if (status.toolchain) {
        updateComponentStatus('toolchain', status.toolchain);
    }
    if (status.sysconfig) {
        updateComponentStatus('sysconfig', status.sysconfig);
    }
    if (status.debugger) {
        updateComponentStatus('debugger', {
            installed: true,
            message: 'SWD Debugger ready',
            version: 'v1.0.0'
        });
    }
    
    updateFooterStatus('Ready');
}

function updateComponentStatus(component, componentStatus) {
    const card = statusCards[component];
    if (!card || !card.card) return;
    
    const isInstalled = componentStatus.installed;
    const hasWarning = componentStatus.warning;
    const hasError = componentStatus.error;
    
    // Update card class
    card.card.className = 'status-card';
    if (hasError) {
        card.card.classList.add('error');
    } else if (hasWarning) {
        card.card.classList.add('warning');
    } else if (isInstalled) {
        card.card.classList.add('installed');
    }
    
    // Update icon
    if (hasError) {
        card.icon.textContent = '✕';
        card.icon.className = 'status-icon error';
    } else if (hasWarning) {
        card.icon.textContent = '⚠';
        card.icon.className = 'status-icon warning';
    } else if (isInstalled) {
        card.icon.textContent = '✓';
        card.icon.className = 'status-icon success';
    } else {
        card.icon.textContent = '○';
        card.icon.className = 'status-icon';
    }
    
    // Update details and version
    card.details.textContent = componentStatus.message || 'Status unknown';
    card.version.textContent = componentStatus.version ? `Version: ${componentStatus.version}` : '';
}

// Progress updates
function updateSetupProgress(data) {
    if (!progressSection) return;
    
    progressSection.style.display = 'block';
    
    if (progressBar && data.progress !== undefined) {
        progressBar.style.width = data.progress + '%';
    }
    
    if (progressStage && data.stage) {
        progressStage.textContent = formatStage(data.stage);
    }
    
    if (progressPercentage && data.progress !== undefined) {
        progressPercentage.textContent = Math.round(data.progress) + '%';
    }
    
    if (progressText && data.message) {
        progressText.textContent = data.message;
    }
    
    updateFooterStatus(data.message || 'Setup in progress...');
}

function hideProgress() {
    if (progressSection) {
        progressSection.style.display = 'none';
    }
}

function formatStage(stage) {
    const stages = {
        'downloading': '⬇️ Downloading',
        'extracting': '📦 Extracting',
        'installing': '⚙️ Installing',
        'configuring': '🔧 Configuring',
        'validating': '✓ Validating',
        'complete': '✅ Complete',
        'error': '❌ Error'
    };
    return stages[stage] || stage;
}

// Boards list
function updateBoardsList(boards) {
    if (!boardsList) return;
    
    if (!boards || boards.length === 0) {
        boardsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📱</div>
                <p>No boards detected</p>
                <small>Click "Detect Boards" to scan for connected devices</small>
            </div>
        `;
        return;
    }
    
    const boardItems = boards.map(board => `
        <div class="board-item ${board.isConnected ? 'connected' : ''}">
            <div class="board-icon">${board.deviceType === 'MSPM0' ? '🔌' : '📱'}</div>
            <div class="board-info">
                <div class="board-name">${board.friendlyName || board.path}</div>
                <div class="board-details">
                    ${board.port || board.path}
                    ${board.manufacturer ? ` • ${board.manufacturer}` : ''}
                    ${board.vendorId && board.productId ? ` • ${board.vendorId}:${board.productId}` : ''}
                </div>
            </div>
            ${board.isConnected ? '<div class="board-badge">Connected</div>' : ''}
        </div>
    `).join('');
    
    boardsList.innerHTML = boardItems;
}

// Debug section
function showDebugSection() {
    if (debugSection) {
        debugSection.style.display = 'block';
    }
}

function hideDebugSection() {
    if (debugSection) {
        debugSection.style.display = 'none';
    }
}

function switchDebugTab(tabName) {
    currentDebugTab = tabName;
    
    // Update tab buttons
    debugTabs.forEach(tab => {
        if (tab.getAttribute('data-tab') === tabName) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
    
    // Show/hide tab content
    const tabContents = document.querySelectorAll('.debug-tab-content');
    tabContents.forEach(content => {
        content.style.display = 'none';
    });
    
    const activeTab = document.getElementById(`${tabName}-tab`);
    if (activeTab) {
        activeTab.style.display = 'block';
    }
}

function updateRegisters(registers) {
    if (!registersList) return;
    
    if (!registers || registers.length === 0) {
        registersList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📊</div>
                <p>No register data</p>
                <small>Waiting for debug information...</small>
            </div>
        `;
        return;
    }
    
    const registerItems = registers.map(reg => `
        <div class="register-item">
            <div class="register-name">${reg.name}</div>
            <div class="register-value">${reg.value}</div>
            ${reg.description ? `<div class="register-desc">${reg.description}</div>` : ''}
        </div>
    `).join('');
    
    registersList.innerHTML = `<div class="register-grid">${registerItems}</div>`;
}

function updateMemoryViewer(data) {
    if (!memoryViewer) return;
    
    if (!data || !data.data) {
        memoryViewer.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">💾</div>
                <p>No memory data</p>
                <small>Enter an address and click Read</small>
            </div>
        `;
        return;
    }
    
    // Parse memory data (assuming hex format)
    const address = data.address;
    const memoryData = data.data;
    
    memoryViewer.innerHTML = `
        <div class="memory-dump">
            <div class="memory-header">
                <span>Address</span>
                <span>Hex</span>
                <span>ASCII</span>
            </div>
            <div class="memory-content">
                <code>${formatMemoryDump(address, memoryData)}</code>
            </div>
        </div>
    `;
}

function formatMemoryDump(baseAddress, data) {
    // Simple memory dump formatter
    // This is a placeholder - actual implementation would parse binary data
    return `${baseAddress}: ${data}`;
}

// Footer updates
function updateFooterStatus(status) {
    const footerStatus = document.getElementById('footer-status');
    if (footerStatus) {
        footerStatus.textContent = status;
    }
}

function showError(message) {
    updateFooterStatus(`Error: ${message}`);
    console.error('Extension error:', message);
}