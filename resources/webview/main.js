// VS Code API
const vscode = acquireVsCodeApi();

// DOM Elements
let buildBtn, flashBtn, debugBtn, setupBtn;
let refreshStatusBtn, detectBoardsBtn;
let progressSection, progressBar, progressText;
let boardsList;
let statusCards = {};

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
    buildBtn = document.getElementById('build-btn');
    flashBtn = document.getElementById('flash-btn');
    debugBtn = document.getElementById('debug-btn');
    setupBtn = document.getElementById('setup-btn');
    
    // Control buttons
    refreshStatusBtn = document.getElementById('refresh-status-btn');
    detectBoardsBtn = document.getElementById('detect-boards-btn');
    
    // Progress elements
    progressSection = document.getElementById('progress-section');
    progressBar = document.getElementById('progress-bar');
    progressText = document.getElementById('progress-text');
    
    // Lists
    boardsList = document.getElementById('boards-list');
    
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
        }
    };
}

function attachEventListeners() {
    // Action button handlers
    if (buildBtn) {
        buildBtn.addEventListener('click', buildProject);
    }
    
    if (flashBtn) {
        flashBtn.addEventListener('click', flashFirmware);
    }
    
    if (debugBtn) {
        debugBtn.addEventListener('click', startDebug);
    }
    
    if (setupBtn) {
        setupBtn.addEventListener('click', runSetup);
    }
    
    // Control button handlers
    if (refreshStatusBtn) {
        refreshStatusBtn.addEventListener('click', refreshStatus);
    }
    
    if (detectBoardsBtn) {
        detectBoardsBtn.addEventListener('click', detectBoards);
    }
}

// Action handlers
function buildProject() {
    vscode.postMessage({ command: 'build' });
    showProgress('Building project...', 0);
    disableActions();
}

function flashFirmware() {
    vscode.postMessage({ command: 'flash' });
    showProgress('Flashing firmware...', 0);
    disableActions();
}

function startDebug() {
    vscode.postMessage({ command: 'debug' });
    showProgress('Starting debug session...', 0);
    disableActions();
}

function runSetup() {
    vscode.postMessage({ command: 'setup' });
    showProgress('Running setup...', 0);
    disableActions();
}

function refreshStatus() {
    vscode.postMessage({ command: 'refreshStatus' });
    showProgress('Refreshing status...', 0);
    
    // Reset all status cards to loading state
    Object.keys(statusCards).forEach(key => {
        const card = statusCards[key];
        if (card.card) {
            card.card.className = 'status-card';
            card.icon.textContent = '○';
            card.icon.className = 'status-icon';
            card.details.textContent = 'Checking installation...';
            card.version.textContent = '';
        }
    });
}

function detectBoards() {
    vscode.postMessage({ command: 'detectBoards' });
    showProgress('Detecting boards...', 0);
    
    // Show loading state for boards list
    if (boardsList) {
        boardsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🔍</div>
                <p>Scanning for boards...</p>
                <small>Please wait while we detect connected devices</small>
            </div>
        `;
    }
}

function requestStatus() {
    vscode.postMessage({ command: 'getStatus' });
}

// Progress management
function showProgress(message, progress = 0) {
    if (progressSection && progressBar && progressText) {
        progressSection.style.display = 'block';
        progressText.textContent = message;
        progressBar.style.width = progress + '%';
        
        // Animate progress if not specified
        if (progress === 0) {
            animateProgress();
        }
    }
}

function hideProgress() {
    if (progressSection) {
        progressSection.style.display = 'none';
    }
    enableActions();
}

function updateProgress(progress, message) {
    if (progressBar && progressText) {
        progressBar.style.width = Math.min(100, Math.max(0, progress)) + '%';
        if (message) {
            progressText.textContent = message;
        }
    }
}

function animateProgress() {
    let progress = 0;
    const interval = setInterval(() => {
        progress += Math.random() * 10;
        if (progress > 85) {
            progress = 85;
            clearInterval(interval);
        }
        if (progressBar) {
            progressBar.style.width = progress + '%';
        }
    }, 300);
    
    // Store interval reference for potential cleanup
    window.progressInterval = interval;
}

// Action state management
function disableActions() {
    const buttons = [buildBtn, flashBtn, debugBtn];
    buttons.forEach(btn => {
        if (btn) {
            btn.disabled = true;
        }
    });
}

function enableActions() {
    const buttons = [buildBtn, flashBtn, debugBtn];
    buttons.forEach(btn => {
        if (btn) {
            btn.disabled = false;
        }
    });
    
    // Clear any progress animation
    if (window.progressInterval) {
        clearInterval(window.progressInterval);
        window.progressInterval = null;
    }
}

// Status updates
function updateSystemStatus(status) {
    updateComponentStatus('sdk', status.sdk);
    updateComponentStatus('toolchain', status.toolchain);
    updateComponentStatus('sysconfig', status.sysconfig);
    
    // Update global status indicator in header
    updateGlobalStatus(status);
    
    // Update action button states based on overall status
    updateActionStates(status);
}

function updateGlobalStatus(status) {
    const headerElement = document.querySelector('.header-content h1');
    if (!headerElement) return;
    
    const allInstalled = status.sdk?.installed && status.toolchain?.installed && status.sysconfig?.installed;
    const hasErrors = status.sdk?.error || status.toolchain?.error || status.sysconfig?.error;
    const hasWarnings = status.sdk?.warning || status.toolchain?.warning || status.sysconfig?.warning;
    
    // Remove existing status indicators
    const existingStatus = headerElement.querySelector('.global-status');
    if (existingStatus) {
        existingStatus.remove();
    }
    
    // Add global status indicator
    const statusIndicator = document.createElement('div');
    statusIndicator.className = 'global-status';
    
    if (allInstalled && !hasErrors) {
        statusIndicator.innerHTML = '<span class="status-dot success"></span>Ready for Development';
        statusIndicator.className += ' success';
    } else if (hasErrors) {
        statusIndicator.innerHTML = '<span class="status-dot error"></span>Setup Issues Detected';
        statusIndicator.className += ' error';
    } else if (hasWarnings) {
        statusIndicator.innerHTML = '<span class="status-dot warning"></span>Setup Warnings';
        statusIndicator.className += ' warning';
    } else {
        statusIndicator.innerHTML = '<span class="status-dot pending"></span>Setup Required';
        statusIndicator.className += ' pending';
    }
    
    headerElement.appendChild(statusIndicator);
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

function updateActionStates(status) {
    // Enable/disable actions based on system status
    const allInstalled = status.sdk?.installed && status.toolchain?.installed && status.sysconfig?.installed;
    
    if (buildBtn) {
        buildBtn.disabled = !allInstalled;
    }
    
    if (flashBtn) {
        flashBtn.disabled = !allInstalled;
    }
    
    if (debugBtn) {
        debugBtn.disabled = !allInstalled;
    }
}

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
    
    // Create board items
    const boardItems = boards.map(board => `
        <div class="board-item">
            <div class="board-icon">${board.name ? board.name.charAt(0).toUpperCase() : 'B'}</div>
            <div class="board-details">
                <div class="board-name">${board.name || 'Unknown Board'}</div>
                <div class="board-info">${board.port || 'Unknown Port'} - ${board.description || 'Board detected'}</div>
            </div>
            <div class="board-status">${board.status || 'Connected'}</div>
        </div>
    `).join('');
    
    boardsList.innerHTML = boardItems;
}

// Message handling from extension
window.addEventListener('message', event => {
    const message = event.data;
    
    try {
        switch (message.command) {
            case 'updateStatus':
                updateSystemStatus(message.status);
                break;
                
            case 'updateBoards':
                updateBoardsList(message.boards);
                hideProgress();
                break;
                
            case 'updateProgress':
                updateProgress(message.progress, message.message);
                break;
                
            case 'hideProgress':
                hideProgress();
                break;
                
            case 'showProgress':
                showProgress(message.message, message.progress);
                break;
                
            case 'showNotification':
                showNotification(message.text, message.type);
                break;
                
            case 'enableActions':
                enableActions();
                break;
                
            case 'disableActions':
                disableActions();
                break;

            case 'buildProgress':
                updateBuildProgress(message.data);
                break;
                
            case 'buildStarted':
                onBuildStarted(message.data);
                break;
                
            case 'buildCompleted':
                onBuildCompleted(message.data);
                break;
                
            case 'buildError':
                onBuildError(message.data);
                break;
                
            case 'buildCancelled':
                onBuildCancelled(message.data);
                break;
                
            case 'updateBuildState':
                updateBuildState(message.data);
                break;
                
            default:
                console.log('Unknown message command:', message.command);
        }
    } catch (error) {
        console.error('Error handling message:', error);
        showNotification('An error occurred while processing the response', 'error');
    }
});

function updateBuildProgress(data) {
    // Update progress bar and status
    if (progressBar && progressText) {
        progressBar.style.width = data.percentage + '%';
        progressText.textContent = `${data.message} (${data.percentage}%)`;
        
        if (data.currentFile) {
            progressText.textContent += ` - ${data.currentFile}`;
        }
    }
    
    showProgress(data.message, data.percentage);
}

function onBuildStarted(data) {
    disableActions();
    showProgress('Starting build process...', 0);
    
    // Show cancel button if available
    const cancelBtn = document.getElementById('cancel-build-btn');
    if (cancelBtn) {
        cancelBtn.style.display = 'inline-block';
    }
}

function onBuildCompleted(data) {
    enableActions();
    hideProgress();
    
    const message = data.success 
        ? `Build completed successfully in ${(data.buildTime / 1000).toFixed(1)}s`
        : `Build failed with ${data.errors} errors`;
    
    showNotification(message, data.success ? 'success' : 'error');
    
    // Hide cancel button
    const cancelBtn = document.getElementById('cancel-build-btn');
    if (cancelBtn) {
        cancelBtn.style.display = 'none';
    }
}

function onBuildError(data) {
    enableActions();
    hideProgress();
    showNotification(`Build error: ${data.message}`, 'error');
}

function onBuildCancelled(data) {
    enableActions();
    hideProgress();
    showNotification('Build cancelled by user', 'warning');
}

function updateBuildState(data) {
    // Enable/disable build button
    const buildBtn = document.getElementById('build-btn');
    if (buildBtn) {
        buildBtn.disabled = data.building;
    }
    
    // Show/hide cancel button
    const cancelBtn = document.getElementById('cancel-build-btn');
    if (cancelBtn) {
        cancelBtn.style.display = data.canCancel ? 'inline-block' : 'none';
    }
}

// Add cancel build function
function cancelBuild() {
    vscode.postMessage({ command: 'cancelBuild' });
}

// Notification system
function showNotification(text, type = 'info') {
    // Remove existing notifications
    const existingNotifications = document.querySelectorAll('.notification');
    existingNotifications.forEach(n => n.remove());
    
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    
    // Set content
    notification.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-weight: 600;">${getNotificationIcon(type)}</span>
            <span>${text}</span>
        </div>
    `;
    
    // Add to document
    document.body.appendChild(notification);
    
    // Show notification with animation
    requestAnimationFrame(() => {
        notification.style.transform = 'translateX(0)';
        notification.style.opacity = '1';
    });
    
    // Auto-hide after delay
    setTimeout(() => {
        notification.style.transform = 'translateX(100%)';
        notification.style.opacity = '0';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, type === 'error' ? 5000 : 3000);
}

function getNotificationIcon(type) {
    switch (type) {
        case 'success': return '✓';
        case 'error': return '✕';
        case 'warning': return '⚠';
        case 'info': 
        default: return 'ℹ';
    }
}

// Utility functions
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

// Error handling
window.addEventListener('error', function(event) {
    console.error('JavaScript error:', event.error);
    showNotification('An unexpected error occurred. Check the logs for details.', 'error');
});

// Handle page visibility changes
document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
        // Page became visible, refresh status
        requestStatus();
    }
});

// Add dynamic notification styles
function addNotificationStyles() {
    if (document.getElementById('notification-styles')) {
        return; // Already added
    }
    
    const style = document.createElement('style');
    style.id = 'notification-styles';
    style.textContent = `
        .notification {
            position: fixed;
            top: var(--space-lg);
            right: var(--space-lg);
            max-width: 300px;
            padding: var(--space-md);
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            color: var(--text-primary);
            font-size: var(--font-size);
            box-shadow: var(--shadow-medium);
            z-index: 1000;
            transform: translateX(100%);
            opacity: 0;
            transition: all 0.3s ease;
            word-wrap: break-word;
        }
        
        .notification.notification-success {
            border-left: 3px solid var(--success-color);
        }
        
        .notification.notification-error {
            border-left: 3px solid var(--error-color);
        }
        
        .notification.notification-warning {
            border-left: 3px solid var(--warning-color);
        }
        
        .notification.notification-info {
            border-left: 3px solid var(--info-color);
        }
        
        @media (max-width: 768px) {
            .notification {
                left: var(--space-sm);
                right: var(--space-sm);
                max-width: none;
                top: var(--space-sm);
                transform: translateY(-100%);
            }
        }
    `;
    document.head.appendChild(style);
}

// Initialize notification styles
addNotificationStyles();

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        showNotification,
        updateSystemStatus,
        updateBoardsList
    };
}