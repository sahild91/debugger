// Get VS Code API
const vscode = acquireVsCodeApi();

// Global state
let currentStatus = {
    sdkInstalled: false,
    toolchainInstalled: false,
    boardConnected: false,
    setupComplete: false
};

let isSetupInProgress = false;
let currentDebugSession = null;

// DOM Elements - will be populated on DOMContentLoaded
let elements = {};

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    console.log('Port11 Debugger webview initialized');
    
    // Cache DOM elements
    cacheElements();
    
    // Set up event listeners
    setupEventListeners();
    
    // Request initial status
    requestStatus();
    
    // Set up periodic status updates
    setInterval(requestStatus, 30000); // Every 30 seconds
});

// Cache frequently used DOM elements
function cacheElements() {
    elements = {
        // Status elements
        sdkStatus: document.getElementById('sdk-status-text'),
        sdkVersion: document.getElementById('sdk-version'),
        sdkIndicator: document.getElementById('sdk-indicator'),
        
        toolchainStatus: document.getElementById('toolchain-status-text'),
        toolchainVersion: document.getElementById('toolchain-version'),
        toolchainIndicator: document.getElementById('toolchain-indicator'),
        
        boardStatus: document.getElementById('board-status-text'),
        boardCount: document.getElementById('board-count'),
        boardIndicator: document.getElementById('board-indicator'),
        
        // Action buttons
        setupBtn: document.getElementById('setup-btn'),
        buildBtn: document.getElementById('build-btn'),
        flashBtn: document.getElementById('flash-btn'),
        debugBtn: document.getElementById('debug-btn'),
        
        // Board management
        detectBoardsBtn: document.getElementById('detect-boards-btn'),
        boardsList: document.getElementById('boards-list'),
        
        // Debug controls
        debugSection: document.getElementById('debug-section'),
        debugStatus: document.getElementById('debug-status'),
        debugHaltBtn: document.getElementById('debug-halt-btn'),
        debugResumeBtn: document.getElementById('debug-resume-btn'),
        debugStopBtn: document.getElementById('debug-stop-btn'),
        registersList: document.getElementById('registers-list'),
        
        // Progress
        setupProgress: document.getElementById('setup-progress'),
        progressTitle: document.getElementById('progress-title'),
        progressPercentage: document.getElementById('progress-percentage'),
        progressFill: document.getElementById('progress-fill'),
        progressText: document.getElementById('progress-text'),
        progressDetails: document.getElementById('progress-details'),
        
        // Footer
        footerStatus: document.getElementById('footer-status'),
        refreshStatusBtn: document.getElementById('refresh-status-btn'),
        settingsBtn: document.getElementById('settings-btn'),
        logsBtn: document.getElementById('logs-btn')
    };
}

// Set up all event listeners
function setupEventListeners() {
    // Action buttons
    elements.setupBtn?.addEventListener('click', startSetup);
    elements.buildBtn?.addEventListener('click', buildProject);
    elements.flashBtn?.addEventListener('click', flashFirmware);
    elements.debugBtn?.addEventListener('click', startDebug);
    
    // Board management
    elements.detectBoardsBtn?.addEventListener('click', detectBoards);
    
    // Debug controls
    elements.debugHaltBtn?.addEventListener('click', haltDebug);
    elements.debugResumeBtn?.addEventListener('click', resumeDebug);
    elements.debugStopBtn?.addEventListener('click', stopDebug);
    
    // Utility buttons
    elements.refreshStatusBtn?.addEventListener('click', requestStatus);
    elements.settingsBtn?.addEventListener('click', openSettings);
    elements.logsBtn?.addEventListener('click', showLogs);
    
    // Listen for messages from extension
    window.addEventListener('message', handleMessage);
}

// Message handling
function handleMessage(event) {
    const message = event.data;
    console.log('Received message:', message.command, message.data);
    
    try {
        switch (message.command) {
            case 'updateStatus':
                handleStatusUpdate(message.data);
                break;
            case 'setupProgress':
                handleSetupProgress(message.data);
                break;
            case 'setupComplete':
                handleSetupComplete(message.data);
                break;
            case 'setupError':
                handleSetupError(message.data);
                break;
            case 'sdkProgress':
                handleSDKProgress(message.data);
                break;
            case 'toolchainProgress':
                handleToolchainProgress(message.data);
                break;
            case 'boardsDetected':
                handleBoardsDetected(message.data.boards);
                break;
            case 'boardConnected':
                handleBoardConnection(message.data);
                break;
            case 'boardDisconnected':
                handleBoardDisconnection(message.data);
                break;
            case 'debugStarted':
                handleDebugStarted(message.data);
                break;
            case 'debugStopped':
                handleDebugStopped(message.data);
                break;
            case 'debugStatus':
                handleDebugStatus(message.data);
                break;
            case 'registersUpdate':
                handleRegistersUpdate(message.data);
                break;
            case 'buildComplete':
                handleBuildComplete(message.data);
                break;
            case 'flashComplete':
                handleFlashComplete(message.data);
                break;
            case 'error':
                handleError(message.data.message);
                break;
            default:
                console.log('Unknown message command:', message.command);
        }
    } catch (error) {
        console.error('Error handling message:', error);
        showError(`Failed to handle message: ${error.message}`);
    }
}

// Action handlers
function startSetup() {
    if (isSetupInProgress) {
        showError('Setup is already in progress');
        return;
    }
    
    console.log('Starting setup...');
    sendMessage('startSetup');
}

function buildProject() {
    if (!currentStatus.setupComplete) {
        showError('Please complete setup before building');
        return;
    }
    
    console.log('Building project...');
    sendMessage('buildProject');
    setFooterStatus('Building...');
}

function flashFirmware() {
    if (!currentStatus.setupComplete) {
        showError('Please complete setup before flashing');
        return;
    }
    
    if (!currentStatus.boardConnected) {
        showError('No board connected. Please connect a board first.');
        return;
    }
    
    console.log('Flashing firmware...');
    sendMessage('flashFirmware');
    setFooterStatus('Flashing...');
}

function startDebug() {
    if (!currentStatus.setupComplete) {
        showError('Please complete setup before debugging');
        return;
    }
    
    if (!currentStatus.boardConnected) {
        showError('No board connected. Please connect a board first.');
        return;
    }
    
    console.log('Starting debug session...');
    sendMessage('startDebug');
    setFooterStatus('Starting debug...');
}

function detectBoards() {
    console.log('Detecting boards...');
    sendMessage('detectBoards');
    setFooterStatus('Detecting boards...');
}

function haltDebug() {
    if (!currentDebugSession) {
        showError('No active debug session');
        return;
    }
    
    console.log('Halting debug session...');
    sendMessage('haltDebug');
}

function resumeDebug() {
    if (!currentDebugSession) {
        showError('No active debug session');
        return;
    }
    
    console.log('Resuming debug session...');
    sendMessage('resumeDebug');
}

function stopDebug() {
    if (!currentDebugSession) {
        showError('No active debug session');
        return;
    }
    
    console.log('Stopping debug session...');
    sendMessage('stopDebug');
}

function requestStatus() {
    console.log('Requesting status update...');
    sendMessage('getStatus');
}

function openSettings() {
    console.log('Opening settings...');
    sendMessage('openSettings');
}

function showLogs() {
    console.log('Showing logs...');
    sendMessage('showLogs');
}

// Message handlers
function handleStatusUpdate(data) {
    currentStatus = data.status;
    
    console.log('Status updated:', currentStatus);
    
    // Update SDK status
    updateStatusItem('sdk', data.status.sdkInstalled, data.sdkVersion || 'Unknown');
    
    // Update toolchain status
    const toolchainText = data.toolchainInfo?.isInstalled ? 
        `Version ${data.toolchainInfo.version}` : 
        'Not installed';
    updateStatusItem('toolchain', data.status.toolchainInstalled, toolchainText);
    
    // Update board status
    const boardText = data.status.boardConnected ? 
        `${data.connectedPorts?.length || 0} board(s) connected` : 
        'No boards connected';
    updateStatusItem('board', data.status.boardConnected, boardText);
    
    // Update action buttons
    updateActionButtons();
    
    // Update footer status
    setFooterStatus(data.status.setupComplete ? 'Ready' : 'Setup required');
}

function handleSetupProgress(data) {
    showSetupProgress(true);
    
    if (elements.progressTitle) elements.progressTitle.textContent = data.stage || 'Setup in progress...';
    if (elements.progressPercentage) elements.progressPercentage.textContent = `${data.progress || 0}%`;
    if (elements.progressFill) elements.progressFill.style.width = `${data.progress || 0}%`;
    if (elements.progressText) elements.progressText.textContent = data.message || 'Processing...';
    
    isSetupInProgress = true;
    setFooterStatus(`Setup: ${data.message}`);
}

function handleSetupComplete(data) {
    showSetupProgress(false);
    isSetupInProgress = false;
    
    console.log('Setup completed successfully');
    showSuccess('Setup completed successfully!');
    setFooterStatus('Setup complete - Ready');
    
    // Refresh status
    requestStatus();
}

function handleSetupError(data) {
    showSetupProgress(false);
    isSetupInProgress = false;
    
    console.error('Setup failed:', data.error);
    showError(`Setup failed: ${data.error}`);
    setFooterStatus('Setup failed');
}

function handleSDKProgress(data) {
    if (elements.progressDetails) {
        elements.progressDetails.textContent = `SDK: ${data.message}`;
    }
}

function handleToolchainProgress(data) {
    if (elements.progressDetails) {
        elements.progressDetails.textContent = `Toolchain: ${data.message}`;
    }
}

function handleBoardsDetected(boards) {
    console.log('Boards detected:', boards);
    updateBoardsList(boards);
    
    if (boards && boards.length > 0) {
        setFooterStatus(`Found ${boards.length} board(s)`);
    } else {
        setFooterStatus('No boards found');
    }
}

function handleBoardConnection(data) {
    console.log('Board connected:', data);
    showSuccess(`Board connected: ${data.board?.friendlyName || 'Unknown'}`);
    requestStatus(); // Refresh status to update UI
}

function handleBoardDisconnection(data) {
    console.log('Board disconnected:', data);
    showWarning(`Board disconnected: ${data.board?.friendlyName || 'Unknown'}`);
    requestStatus(); // Refresh status to update UI
}

function handleDebugStarted(data) {
    console.log('Debug session started:', data);
    currentDebugSession = data.session;
    
    // Show debug section
    if (elements.debugSection) {
        elements.debugSection.style.display = 'block';
    }
    
    // Update debug status
    updateDebugStatus('Running');
    
    // Enable debug controls
    updateDebugControls(true);
    
    showSuccess('Debug session started');
    setFooterStatus('Debugging active');
}

function handleDebugStopped(data) {
    console.log('Debug session stopped:', data);
    currentDebugSession = null;
    
    // Update debug status
    updateDebugStatus('Stopped');
    
    // Disable debug controls
    updateDebugControls(false);
    
    // Clear registers
    clearRegisters();
    
    showInfo('Debug session stopped');
    setFooterStatus('Ready');
}

function handleDebugStatus(data) {
    console.log('Debug status update:', data);
    updateDebugStatus(data.status);
}

function handleRegistersUpdate(data) {
    console.log('Registers updated:', data);
    updateRegistersDisplay(data.registers);
}

function handleBuildComplete(data) {
    console.log('Build completed:', data);
    
    if (data.success) {
        showSuccess(`Build completed successfully in ${data.buildTime}ms`);
        setFooterStatus('Build successful');
    } else {
        showError(`Build failed: ${data.error || 'Unknown error'}`);
        setFooterStatus('Build failed');
    }
}

function handleFlashComplete(data) {
    console.log('Flash completed:', data);
    
    if (data.success) {
        showSuccess('Firmware flashed successfully');
        setFooterStatus('Flash successful');
    } else {
        showError(`Flash failed: ${data.error || 'Unknown error'}`);
        setFooterStatus('Flash failed');
    }
}

function handleError(message) {
    console.error('Extension error:', message);
    showError(message);
}

// UI Update Functions
function updateStatusItem(type, isInstalled, statusText) {
    const statusElement = elements[`${type}Status`];
    const versionElement = elements[`${type}Version`];
    const indicatorElement = elements[`${type}Indicator`];
    
    if (statusElement) {
        statusElement.textContent = isInstalled ? 'Installed' : 'Not installed';
    }
    
    if (versionElement && statusText) {
        versionElement.textContent = statusText;
    }
    
    if (indicatorElement) {
        // Clear existing classes and spinner
        indicatorElement.innerHTML = '';
        indicatorElement.className = 'status-indicator';
        
        if (isInstalled) {
            indicatorElement.classList.add('success');
            indicatorElement.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M6.5 12L2 7.5L3.5 6L6.5 9L12.5 3L14 4.5L6.5 12Z"/>
                </svg>
            `;
        } else {
            indicatorElement.classList.add('error');
            indicatorElement.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1L15 15H1L8 1ZM8 5V9H8V5ZM8 11V13H8V11Z"/>
                </svg>
            `;
        }
    }
}

function updateActionButtons() {
    const setupComplete = currentStatus.setupComplete;
    const boardConnected = currentStatus.boardConnected;
    
    // Setup button - always enabled
    if (elements.setupBtn) {
        elements.setupBtn.disabled = false;
        elements.setupBtn.textContent = setupComplete ? 'Re-run Setup' : 'Setup Toolchain';
    }
    
    // Build button - enabled when setup is complete
    if (elements.buildBtn) {
        elements.buildBtn.disabled = !setupComplete || isSetupInProgress;
    }
    
    // Flash button - enabled when setup is complete and board is connected
    if (elements.flashBtn) {
        elements.flashBtn.disabled = !setupComplete || !boardConnected || isSetupInProgress;
    }
    
    // Debug button - enabled when setup is complete and board is connected
    if (elements.debugBtn) {
        elements.debugBtn.disabled = !setupComplete || !boardConnected || isSetupInProgress;
        
        if (currentDebugSession) {
            elements.debugBtn.innerHTML = `
                <div class="action-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6h12v12H6z"/>
                    </svg>
                </div>
                <div class="action-content">
                    <h3>Stop Debug</h3>
                    <p>End debug session</p>
                </div>
            `;
            elements.debugBtn.onclick = stopDebug;
        } else {
            elements.debugBtn.innerHTML = `
                <div class="action-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M20 8H17.19C16.74 7.22 16.12 6.55 15.37 6.04L17 4.41L15.59 3L13.42 5.17C12.96 5.06 12.49 5 12 5S11.04 5.06 10.59 5.17L8.41 3L7 4.41L8.62 6.04C7.88 6.55 7.26 7.22 6.81 8H4V10H6.09C6.04 10.33 6 10.66 6 11V12H4V14H6V15C6 15.34 6.04 15.67 6.09 16H4V18H6.81C7.85 19.79 9.78 21 12 21S16.15 19.79 17.19 18H20V16H17.91C17.96 15.67 18 15.34 18 15V14H20V12H18V11C18 10.66 17.96 10.33 17.91 10H20V8ZM16 15C16 16.66 14.66 18 13 18H11C9.34 18 8 16.66 8 15V11C8 9.34 9.34 8 11 8H13C14.66 8 16 9.34 16 11V15Z"/>
                    </svg>
                </div>
                <div class="action-content">
                    <h3>Start Debug</h3>
                    <p>Debug your firmware</p>
                </div>
            `;
            elements.debugBtn.onclick = startDebug;
        }
    }
}

function updateBoardsList(boards) {
    if (!elements.boardsList) return;
    
    if (!boards || boards.length === 0) {
        elements.boardsList.innerHTML = `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="currentColor" class="empty-icon">
                    <path d="M6 6h36v36H6V6zm6 6v24h24V12H12zm6 6h12v3H18v-3zm0 6h12v3H18v-3z"/>
                </svg>
                <p>No boards detected</p>
                <small>Click "Detect Boards" to scan for connected devices</small>
            </div>
        `;
        return;
    }
    
    const boardsHtml = boards.map(board => `
        <div class="board-item">
            <div class="board-icon">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M2 2h12v12H2V2zm2 2v8h8V4H4zm2 2h4v1H6V6zm0 2h4v1H6V8zm0 2h4v1H6v-1z"/>
                </svg>
            </div>
            <div class="board-details">
                <h4>${escapeHtml(board.friendlyName || 'Unknown Board')}</h4>
                <p>${escapeHtml(board.port)} - ${escapeHtml(board.manufacturer || 'Unknown')}</p>
            </div>
            <div class="board-actions">
                <button class="btn btn-text" onclick="connectToBoard('${escapeHtml(board.port)}')" title="Connect">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M5.5 2A1.5 1.5 0 0 1 7 0.5h2A1.5 1.5 0 0 1 10.5 2v2h3a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5H13v6.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12.5V6H2.5a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3V2zm1 0v2h3V2a.5.5 0 0 0-.5-.5h-2a.5.5 0 0 0-.5.5z"/>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');
    
    elements.boardsList.innerHTML = boardsHtml;
}

function connectToBoard(port) {
    console.log('Connecting to board:', port);
    sendMessage('connectBoard', { port });
    setFooterStatus(`Connecting to ${port}...`);
}

function showSetupProgress(show) {
    if (elements.setupProgress) {
        elements.setupProgress.style.display = show ? 'block' : 'none';
    }
    
    if (show) {
        // Add animation class
        elements.setupProgress.classList.add('fade-in');
    }
}

function updateDebugStatus(status) {
    if (!elements.debugStatus) return;
    
    elements.debugStatus.textContent = status;
    elements.debugStatus.className = 'status-badge';
    
    switch (status.toLowerCase()) {
        case 'running':
        case 'active':
            elements.debugStatus.classList.add('active');
            break;
        case 'stopped':
        case 'inactive':
            elements.debugStatus.classList.add('stopped');
            break;
        default:
            // Default styling
            break;
    }
}

function updateDebugControls(enabled) {
    if (elements.debugHaltBtn) elements.debugHaltBtn.disabled = !enabled;
    if (elements.debugResumeBtn) elements.debugResumeBtn.disabled = !enabled;
    if (elements.debugStopBtn) elements.debugStopBtn.disabled = !enabled;
}

function updateRegistersDisplay(registers) {
    if (!elements.registersList || !registers) return;
    
    if (registers.length === 0) {
        elements.registersList.innerHTML = `
            <div class="empty-state">
                <p>No register data available</p>
            </div>
        `;
        return;
    }
    
    const registersHtml = registers.map(reg => `
        <div class="register-item">
            <span class="register-name">${escapeHtml(reg.name)}</span>
            <span class="register-value">${escapeHtml(reg.value)}</span>
        </div>
    `).join('');
    
    elements.registersList.innerHTML = registersHtml;
}

function clearRegisters() {
    if (elements.registersList) {
        elements.registersList.innerHTML = `
            <div class="empty-state">
                <p>No debug session active</p>
            </div>
        `;
    }
}

function setFooterStatus(text) {
    if (elements.footerStatus) {
        elements.footerStatus.textContent = text;
    }
}

// Notification functions
function showSuccess(message) {
    showNotification(message, 'success');
}

function showError(message) {
    showNotification(message, 'error');
}

function showWarning(message) {
    showNotification(message, 'warning');
}

function showInfo(message) {
    showNotification(message, 'info');
}

function showNotification(message, type = 'info') {
    console.log(`${type.toUpperCase()}: ${message}`);
    
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    
    // Add to DOM
    document.body.appendChild(notification);
    
    // Animate in
    requestAnimationFrame(() => {
        notification.classList.add('show');
    });
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 5000);
    
    // Also send to extension for logging
    sendMessage('log', { level: type, message });
}

// Utility functions
function sendMessage(command, data = null) {
    try {
        vscode.postMessage({
            command: command,
            data: data
        });
    } catch (error) {
        console.error('Failed to send message:', error);
    }
}

function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Add notification styles dynamically
function addNotificationStyles() {
    const style = document.createElement('style');
    style.textContent = `
        .notification {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 16px;
            border-radius: var(--border-radius);
            color: white;
            font-weight: 500;
            z-index: 1000;
            transform: translateX(100%);
            transition: transform 0.3s ease;
            max-width: 300px;
            word-wrap: break-word;
        }
        
        .notification.show {
            transform: translateX(0);
        }
        
        .notification-success {
            background-color: var(--success-color);
        }
        
        .notification-error {
            background-color: var(--danger-color);
        }
        
        .notification-warning {
            background-color: var(--warning-color);
            color: var(--text-primary);
        }
        
        .notification-info {
            background-color: var(--info-color);
        }
    `;
    document.head.appendChild(style);
}

// Initialize notification styles
addNotificationStyles();

// Export functions for global access
window.connectToBoard = connectToBoard;

// Handle page visibility changes
document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
        // Page became visible, refresh status
        requestStatus();
    }
});

// Handle errors
window.addEventListener('error', function(event) {
    console.error('JavaScript error:', event.error);
    showError('An unexpected error occurred. Check the logs for details.');
});

// Log that initialization is complete
console.log('Port11 Debugger webview client initialized successfully');