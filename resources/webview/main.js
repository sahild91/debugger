// Port11 Debugger Webview JavaScript

(function() {
    const vscode = acquireVsCodeApi();
    
    // UI Elements
    const elements = {
        // Status indicators
        sdkIcon: document.getElementById('sdk-icon'),
        sdkText: document.getElementById('sdk-text'),
        sdkStatus: document.getElementById('sdk-status'),
        
        toolchainIcon: document.getElementById('toolchain-icon'),
        toolchainText: document.getElementById('toolchain-text'),
        toolchainStatus: document.getElementById('toolchain-status'),
        
        boardIcon: document.getElementById('board-icon'),
        boardText: document.getElementById('board-text'),
        boardStatus: document.getElementById('board-status'),
        
        // Buttons
        startSetupBtn: document.getElementById('start-setup-btn'),
        refreshBtn: document.getElementById('refresh-btn'),
        detectBoardsBtn: document.getElementById('detect-boards-btn'),
        buildBtn: document.getElementById('build-btn'),
        flashBtn: document.getElementById('flash-btn'),
        debugBtn: document.getElementById('debug-btn'),
        
        // Progress
        setupProgress: document.getElementById('setup-progress'),
        progressFill: document.getElementById('progress-fill'),
        progressText: document.getElementById('progress-text'),
        
        // Boards
        boardsList: document.getElementById('boards-list'),
        
        // Footer
        footerStatus: document.getElementById('footer-status')
    };
    
    // State
    let currentStatus = {
        sdkInstalled: false,
        toolchainInstalled: false,
        boardConnected: false,
        setupComplete: false
    };
    
    let connectedBoards = [];
    let isSetupInProgress = false;

    // Initialize
    function init() {
        setupEventListeners();
        requestStatus();
        setFooterStatus('Initializing...');
    }

    // Event Listeners
    function setupEventListeners() {
        elements.startSetupBtn.addEventListener('click', startSetup);
        elements.refreshBtn.addEventListener('click', refreshStatus);
        elements.detectBoardsBtn.addEventListener('click', detectBoards);
        elements.buildBtn.addEventListener('click', buildProject);
        elements.flashBtn.addEventListener('click', flashFirmware);
        elements.debugBtn.addEventListener('click', startDebug);

        // Listen for messages from extension
        window.addEventListener('message', handleMessage);
    }

    // Message Handling
    function handleMessage(event) {
        const message = event.data;
        console.log('Received message:', message);

        switch (message.command) {
            case 'statusUpdate':
                updateStatus(message.data);
                break;
            case 'setupStarted':
                handleSetupStarted(message.data);
                break;
            case 'setupComplete':
                handleSetupComplete(message.data);
                break;
            case 'setupError':
                handleSetupError(message.data);
                break;
            case 'sdkProgress':
                updateSDKProgress(message.data);
                break;
            case 'toolchainProgress':
                updateToolchainProgress(message.data);
                break;
            case 'boardsDetected':
                updateBoardsList(message.data.boards);
                break;
            case 'boardConnected':
                handleBoardConnection(message.data);
                break;
            case 'boardDisconnected':
                handleBoardDisconnection(message.data);
                break;
            case 'error':
                showError(message.data.message);
                break;
            default:
                console.log('Unknown message command:', message.command);
        }
    }

    // Send message to extension
    function sendMessage(command, data = null) {
        vscode.postMessage({
            command: command,
            data: data
        });
    }

    // UI Update Functions
    function updateStatus(data) {
        currentStatus = data.status;
        
        // Update SDK status
        updateStatusItem('sdk', data.status.sdkInstalled, data.sdkVersion);
        
        // Update toolchain status
        const toolchainText = data.toolchainInfo.isInstalled ? 
            `Version ${data.toolchainInfo.version}` : 
            'Not installed';
        updateStatusItem('toolchain', data.status.toolchainInstalled, toolchainText);
        
        // Update board status
        const boardText = data.status.boardConnected ? 
            `${data.connectedPorts.length} board(s) connected` : 
            'No boards connected';
        updateStatusItem('board', data.status.boardConnected, boardText);
        
        // Update action buttons
        updateActionButtons();
        
        setFooterStatus(data.status.setupComplete ? 'Ready for development' : 'Setup required');
    }

    function updateStatusItem(type, isInstalled, text) {
        const icon = elements[type + 'Icon'];
        const textElement = elements[type + 'Text'];
        const statusElement = elements[type + 'Status'];
        
        if (isInstalled) {
            icon.textContent = '✅';
            statusElement.className = 'status-item success';
        } else {
            icon.textContent = '❌';
            statusElement.className = 'status-item error';
        }
        
        textElement.textContent = text;
    }

    function updateActionButtons() {
        const canBuild = currentStatus.sdkInstalled && currentStatus.toolchainInstalled;
        const canFlash = canBuild && currentStatus.boardConnected;
        const canDebug = canFlash;
        
        elements.buildBtn.disabled = !canBuild;
        elements.flashBtn.disabled = !canFlash;
        elements.debugBtn.disabled = !canDebug;
        
        elements.startSetupBtn.disabled = isSetupInProgress || currentStatus.setupComplete;
        elements.startSetupBtn.textContent = currentStatus.setupComplete ? 'Setup Complete' : 
                                           isSetupInProgress ? 'Setup in Progress...' : 'Start Setup';
    }

    function showProgress(visible, progress = 0, text = '') {
        elements.setupProgress.style.display = visible ? 'block' : 'none';
        
        if (visible) {
            elements.progressFill.style.width = progress + '%';
            elements.progressText.textContent = text;
        }
    }

    function updateBoardsList(boards) {
        if (!boards || boards.length === 0) {
            elements.boardsList.innerHTML = '<p>No boards detected. Check USB connections and try again.</p>';
            return;
        }

        const boardsHtml = boards.map(board => {
            const isConnected = connectedBoards.includes(board.port);
            const connectionClass = isConnected ? 'connected' : 'disconnected';
            const actionButton = isConnected ?
                `<button class="btn btn-secondary" onclick="disconnectBoard('${board.port}')">Disconnect</button>` :
                `<button class="btn btn-primary" onclick="connectBoard('${board.port}')">Connect</button>`;
            
            return `
                <div class="board-item ${connectionClass}">
                    <div class="board-info">
                        <h4>${board.friendlyName}</h4>
                        <p>${board.port} - ${board.manufacturer || 'Unknown'}</p>
                        ${board.serialNumber ? `<p>Serial: ${board.serialNumber}</p>` : ''}
                    </div>
                    <div class="board-actions">
                        ${actionButton}
                    </div>
                </div>
            `;
        }).join('');

        elements.boardsList.innerHTML = boardsHtml;
    }

    function setFooterStatus(status) {
        elements.footerStatus.textContent = status;
    }

    function showError(message) {
        setFooterStatus(`Error: ${message}`);
        console.error('Port11 Debugger Error:', message);
    }

    // Event Handlers
    function startSetup() {
        if (isSetupInProgress) return;
        
        isSetupInProgress = true;
        showProgress(true, 0, 'Starting setup...');
        updateActionButtons();
        sendMessage('startSetup');
    }

    function refreshStatus() {
        setFooterStatus('Refreshing status...');
        sendMessage('refreshStatus');
    }

    function detectBoards() {
        setFooterStatus('Detecting boards...');
        sendMessage('detectBoards');
    }

    function buildProject() {
        if (!currentStatus.setupComplete) {
            showError('Setup not complete. Please run setup first.');
            return;
        }
        
        setFooterStatus('Building project...');
        sendMessage('buildProject');
    }

    function flashFirmware() {
        if (!currentStatus.boardConnected) {
            showError('No board connected. Please connect a board first.');
            return;
        }
        
        setFooterStatus('Flashing firmware...');
        sendMessage('flashFirmware');
    }

    function startDebug() {
        if (!currentStatus.boardConnected) {
            showError('No board connected. Please connect a board first.');
            return;
        }
        
        setFooterStatus('Starting debug session...');
        sendMessage('startDebug');
    }

    // Global functions for board actions (called from HTML)
    window.connectBoard = function(port) {
        setFooterStatus(`Connecting to ${port}...`);
        sendMessage('connectBoard', { port: port });
    };

    window.disconnectBoard = function(port) {
        setFooterStatus(`Disconnecting from ${port}...`);
        sendMessage('disconnectBoard', { port: port });
    };

    // Setup Event Handlers
    function handleSetupStarted(data) {
        isSetupInProgress = true;
        showProgress(true, 5, data.message);
        updateActionButtons();
        setFooterStatus('Setup in progress...');
    }

    function handleSetupComplete(data) {
        isSetupInProgress = false;
        showProgress(true, 100, data.message);
        updateActionButtons();
        setFooterStatus('Setup completed successfully!');
        
        // Hide progress after 3 seconds
        setTimeout(() => {
            showProgress(false);
            requestStatus(); // Refresh status
        }, 3000);
    }

    function handleSetupError(data) {
        isSetupInProgress = false;
        showProgress(false);
        updateActionButtons();
        showError(data.message);
    }

    function updateSDKProgress(progress) {
        const percentage = Math.min(50, progress.progress * 0.5); // SDK takes up first 50% of total progress
        showProgress(true, percentage, `SDK: ${progress.message}`);
        
        // Update SDK status indicator
        elements.sdkIcon.textContent = progress.stage === 'complete' ? '✅' : '⏳';
        elements.sdkText.textContent = progress.message;
        elements.sdkStatus.className = progress.stage === 'complete' ? 'status-item success' : 
                                      progress.stage === 'error' ? 'status-item error' : 'status-item loading';
    }

    function updateToolchainProgress(progress) {
        const percentage = 50 + Math.min(50, progress.progress * 0.5); // Toolchain takes up second 50%
        showProgress(true, percentage, `Toolchain: ${progress.message}`);
        
        // Update toolchain status indicator
        elements.toolchainIcon.textContent = progress.stage === 'complete' ? '✅' : '⏳';
        elements.toolchainText.textContent = progress.message;
        elements.toolchainStatus.className = progress.stage === 'complete' ? 'status-item success' : 
                                            progress.stage === 'error' ? 'status-item error' : 'status-item loading';
    }

    function handleBoardConnection(data) {
        connectedBoards.push(data.port);
        setFooterStatus(data.message);
        detectBoards(); // Refresh boards list
        requestStatus(); // Update overall status
    }

    function handleBoardDisconnection(data) {
        connectedBoards = connectedBoards.filter(port => port !== data.port);
        setFooterStatus(data.message);
        detectBoards(); // Refresh boards list
        requestStatus(); // Update overall status
    }

    // Utility Functions
    function requestStatus() {
        sendMessage('getStatus');
    }

    // Auto-refresh functionality
    function startAutoRefresh() {
        setInterval(() => {
            if (!isSetupInProgress) {
                requestStatus();
            }
        }, 10000); // Refresh every 10 seconds
    }

    // Keyboard shortcuts
    function setupKeyboardShortcuts() {
        document.addEventListener('keydown', (event) => {
            // Ctrl/Cmd + R: Refresh
            if ((event.ctrlKey || event.metaKey) && event.key === 'r') {
                event.preventDefault();
                refreshStatus();
            }
            
            // Ctrl/Cmd + B: Build
            if ((event.ctrlKey || event.metaKey) && event.key === 'b') {
                event.preventDefault();
                if (!elements.buildBtn.disabled) {
                    buildProject();
                }
            }
            
            // Ctrl/Cmd + F: Flash
            if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
                event.preventDefault();
                if (!elements.flashBtn.disabled) {
                    flashFirmware();
                }
            }
            
            // Ctrl/Cmd + D: Debug
            if ((event.ctrlKey || event.metaKey) && event.key === 'd') {
                event.preventDefault();
                if (!elements.debugBtn.disabled) {
                    startDebug();
                }
            }
        });
    }

    // Error handling for uncaught errors
    window.addEventListener('error', (event) => {
        console.error('Uncaught error in webview:', event.error);
        showError('An unexpected error occurred. Check the output channel for details.');
    });

    // Initialize when DOM is loaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    // Start auto-refresh and keyboard shortcuts
    startAutoRefresh();
    setupKeyboardShortcuts();

    // Export functions for debugging
    window.port11Debug = {
        sendMessage,
        requestStatus,
        currentStatus,
        connectedBoards
    };
})();