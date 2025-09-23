import * as vscode from 'vscode';
import { exec } from 'child_process';
import { WebviewProvider } from './webview/webviewProvider';
import { SDKManager } from './managers/sdkManager';
import { ToolchainManager } from './managers/toolchainManager';
import { SysConfigManager } from './managers/sysconfigManager';
import { SerialManager } from './managers/serialManager';
import { CliManager } from './managers/cliManager';
import { ConnectionManager } from './managers/connectionManager';
import { BuildCommand } from './commands/buildCommand';
import { FlashCommand } from './commands/flashCommand';
import { DebugCommand } from './commands/debugCommand';

let outputChannel: vscode.OutputChannel;
let webviewProvider: WebviewProvider;
let sdkManager: SDKManager;
let toolchainManager: ToolchainManager;
let sysConfigManager: SysConfigManager;
let serialManager: SerialManager;
let cliManager: CliManager;
let connectionManager: ConnectionManager;
let statusBarItem: vscode.StatusBarItem;
let connectStatusBar: vscode.StatusBarItem;

// Utility functions
function escapePathForShell(path: string): string {
    return path.replace(/\s/g, '\\ ');
}

function executeSwdDebuggerCommand(args: string, successMessage: string, requiresPort: boolean = true): Promise<void> {
    return new Promise((resolve, reject) => {
        const executablePath = cliManager.getExecutablePath();
        const escapedPath = escapePathForShell(executablePath);

        // Check if a port is selected and add --port parameter
        const selectedPort = connectionManager.getSelectedPort();

        // Validate port requirement
        if (requiresPort && !selectedPort) {
            const errorMessage = 'No port connected. Please select a port first using the Connect button.';
            outputChannel.appendLine(`❌ ${errorMessage}`);
            vscode.window.showErrorMessage(errorMessage, 'Connect Port').then(selection => {
                if (selection === 'Connect Port') {
                    vscode.commands.executeCommand('extension.connectCommand');
                }
            });
            reject(new Error(errorMessage));
            return;
        }

        let command: string;

        if (selectedPort) {
            // Use quotes around the executable path for Windows compatibility
            if (process.platform === 'win32') {
                command = `"${executablePath}" --port ${selectedPort} ${args}`;
            } else {
                command = `${escapedPath} --port ${selectedPort} ${args}`;
            }
        } else {
            if (process.platform === 'win32') {
                command = `"${executablePath}" ${args}`;
            } else {
                command = `${escapedPath} ${args}`;
            }
        }

        outputChannel.appendLine(`🔧 Executing: ${command}`);
        outputChannel.appendLine(`📝 Debug - executable: ${executablePath}`);
        outputChannel.appendLine(`📝 Debug - selectedPort: ${selectedPort}`);
        outputChannel.appendLine(`📝 Debug - args: ${args}`);

        exec(command, (error, stdout, stderr) => {
            const combinedOutput = stdout + stderr;

            // Check for process-level errors
            if (error) {
                const errorMessage = `swd-debugger ${args.split(' ')[0]} failed: ${error.message}`;
                outputChannel.appendLine(`❌ ${errorMessage}`);
                if (combinedOutput) {
                    outputChannel.appendLine(`Output: ${combinedOutput}`);
                }
                vscode.window.showErrorMessage(errorMessage);
                reject(error);
                return;
            }

            // Display output
            if (combinedOutput) {
                outputChannel.appendLine(`📄 Output: ${combinedOutput}`);
            }

            // Check for application-level errors in the output
            const hasError = combinedOutput.includes('ERROR') ||
                           combinedOutput.includes('Failed to') ||
                           combinedOutput.includes('Error:') ||
                           combinedOutput.includes('failed:') ||
                           combinedOutput.includes('FATAL') ||
                           combinedOutput.includes('not connected') ||
                           combinedOutput.includes('No device found') ||
                           combinedOutput.includes('Permission denied');

            if (hasError) {
                const operation = args.split(' ')[0];
                const errorMessage = `swd-debugger ${operation} failed - check output for details`;
                outputChannel.appendLine(`❌ ${errorMessage}`);
                vscode.window.showErrorMessage(errorMessage);
                reject(new Error(errorMessage));
                return;
            }

            // Success case
            outputChannel.appendLine(`✅ ${successMessage}`);
            vscode.window.showInformationMessage(successMessage);
            resolve();
        });
    });
}

export async function activate(context: vscode.ExtensionContext) {
    // Initialize output channel for logging
    outputChannel = vscode.window.createOutputChannel('Port11 Debugger', 'log');
    
    // Show output channel only in debug mode or if specified in settings
    const showLogsOnStartup = vscode.workspace.getConfiguration('port11-debugger').get('showLogsOnStartup', false);
    if (showLogsOnStartup) {
        outputChannel.show();
    }
    
    outputChannel.clear();
    outputChannel.appendLine('='.repeat(80));
    outputChannel.appendLine('🚀 PORT11 DEBUGGER EXTENSION STARTING');
    outputChannel.appendLine('='.repeat(80));
    outputChannel.appendLine(`⏰ Activation Time: ${new Date().toISOString()}`);
    outputChannel.appendLine(`📍 VS Code version: ${vscode.version}`);
    outputChannel.appendLine(`📁 Extension path: ${context.extensionPath}`);
    outputChannel.appendLine(`💾 Global storage path: ${context.globalStorageUri.fsPath}`);
    outputChannel.appendLine('');

    // Initialize status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    statusBarItem.command = 'port11-debugger.showPanel';
    updateStatusBar('Initializing...');
    
    let flashDisposable = vscode.commands.registerCommand("extension.flashCommand", async () => {
        try {
            outputChannel.appendLine('🚀 Flash command triggered');
            outputChannel.show();
            await executeSwdDebuggerCommand('flash --file build/main.hex', 'Flash operation completed successfully!');
        } catch (error) {
            outputChannel.appendLine(`❌ Flash command failed: ${error}`);
        }
    });

    // Halt command
    let haltDisposable = vscode.commands.registerCommand(
        "extension.haltCommand",
        async () => {
            try {
                outputChannel.appendLine('⏸️ Halt command triggered');
                outputChannel.show();
                await executeSwdDebuggerCommand('halt', 'Target processor halted successfully!');
            } catch (error) {
                outputChannel.appendLine(`❌ Halt command failed: ${error}`);
            }
        }
    );

    // Resume command
    let resumeDisposable = vscode.commands.registerCommand(
        "extension.resumeCommand",
        async () => {
            try {
                outputChannel.appendLine('▶️ Resume command triggered');
                outputChannel.show();
                await executeSwdDebuggerCommand('resume', 'Target processor resumed successfully!');
            } catch (error) {
                outputChannel.appendLine(`❌ Resume command failed: ${error}`);
            }
        }
    );

    // Erase command
    let eraseDisposable = vscode.commands.registerCommand(
        "extension.eraseCommand",
        async () => {
            try {
                outputChannel.appendLine('🗑️ Erase command triggered');
                outputChannel.show();
                await executeSwdDebuggerCommand('erase 0x08000000 0x0801FFFF', 'Flash memory erased successfully!');
            } catch (error) {
                outputChannel.appendLine(`❌ Erase command failed: ${error}`);
            }
        }
    );

    // Connect command
    let connectDisposable = vscode.commands.registerCommand(
        "extension.connectCommand",
        async () => {
            try {
                outputChannel.appendLine('🔌 Connect command triggered');
                outputChannel.show();

                // Check if already connected and offer disconnect option
                if (connectionManager.isPortSelected()) {
                    const currentPort = connectionManager.getPortStatusText();
                    const action = await vscode.window.showQuickPick([
                        { label: '🔌 Select Different Port', description: 'Choose a new serial port' },
                        { label: '🔌 Disconnect', description: `Disconnect from ${currentPort}` }
                    ], {
                        placeHolder: `Currently connected to ${currentPort}`,
                        title: 'Port Connection'
                    });

                    if (action?.label.includes('Disconnect')) {
                        connectionManager.disconnect();
                        updateConnectStatusBar();
                        return;
                    } else if (!action?.label.includes('Different')) {
                        return; // User cancelled
                    }
                }

                const selectedPort = await connectionManager.showPortSelection();
                if (selectedPort) {
                    outputChannel.appendLine(`📍 Selected port: ${selectedPort}`);
                    // Update connect status bar to show selected port
                    updateConnectStatusBar();
                } else {
                    outputChannel.appendLine('❌ No port selected');
                }
            } catch (error) {
                outputChannel.appendLine(`❌ Connect command failed: ${error}`);
            }
        }
    );

    context.subscriptions.push(flashDisposable, haltDisposable, resumeDisposable, eraseDisposable, connectDisposable);
    

    // Create and show the status bar items
    const buildStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
    );
    buildStatusBar.text = "$(tools) Build";
    buildStatusBar.command = "extension.buildCommand";
    buildStatusBar.tooltip = "Build the connected device";
    buildStatusBar.show();

    const flashStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        99
    );
    flashStatusBar.text = "$(zap) Flash";
    flashStatusBar.command = "extension.flashCommand";
    flashStatusBar.tooltip = "Flash the connected device";
    flashStatusBar.show();

    const haltStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        98
    );
    haltStatusBar.text = "$(debug-pause) Halt";
    haltStatusBar.command = "extension.haltCommand";
    haltStatusBar.tooltip = "Halt the target processor";
    haltStatusBar.show();

    const resumeStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        97
    );
    resumeStatusBar.text = "$(debug-continue) Resume";
    resumeStatusBar.command = "extension.resumeCommand";
    resumeStatusBar.tooltip = "Resume the target processor";
    resumeStatusBar.show();

    const eraseStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        96
    );
    eraseStatusBar.text = "$(trash) Erase";
    eraseStatusBar.command = "extension.eraseCommand";
    eraseStatusBar.tooltip = "Erase flash memory";
    eraseStatusBar.show();

    connectStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        95
    );
    connectStatusBar.text = "$(plug) Connect";
    connectStatusBar.command = "extension.connectCommand";
    connectStatusBar.tooltip = "Connect to a serial port";
    connectStatusBar.show();

    context.subscriptions.push(buildStatusBar,flashStatusBar, haltStatusBar, resumeStatusBar, eraseStatusBar, connectStatusBar);

    // Initialize managers
    try {
        outputChannel.appendLine('🔧 Initializing core managers...');
        sdkManager = new SDKManager(context, outputChannel);
        outputChannel.appendLine('  ✅ SDK Manager initialized');

        toolchainManager = new ToolchainManager(context, outputChannel);
        outputChannel.appendLine('  ✅ Toolchain Manager initialized');

        sysConfigManager = new SysConfigManager(context, outputChannel);
        outputChannel.appendLine('  ✅ SysConfig Manager initialized');

        serialManager = new SerialManager(outputChannel);
        outputChannel.appendLine('  ✅ Serial Manager initialized');

        connectionManager = new ConnectionManager(outputChannel);
        outputChannel.appendLine('  ✅ Connection Manager initialized');

        outputChannel.appendLine('🔧 Initializing CLI Manager...');
        cliManager = new CliManager(context);
        try {
            await cliManager.initialize();
            outputChannel.appendLine('  ✅ CLI Manager initialized and swd-debugger ready');
        } catch (error) {
            outputChannel.appendLine(`  ❌ CLI Manager initialization failed: ${error}`);
            throw error;
        }

        outputChannel.appendLine('🎉 All managers initialized successfully');
        outputChannel.appendLine('');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Failed to initialize managers: ${errorMessage}`);
        outputChannel.show(true);
        vscode.window.showErrorMessage(`Port11 Debugger initialization failed: ${errorMessage}`);
        throw error;
    }

    // Initialize commands
    try {
        outputChannel.appendLine('Initializing command handlers...');
        const buildCommand = new BuildCommand(context, outputChannel, sdkManager, toolchainManager, sysConfigManager);
        const flashCommand = new FlashCommand(context, outputChannel, serialManager);
        const debugCommand = new DebugCommand(context, outputChannel, serialManager);
        outputChannel.appendLine('Command handlers initialized successfully');

        // Initialize webview provider
        try {
            outputChannel.appendLine('🌐 Initializing webview provider...');
            webviewProvider = new WebviewProvider(context, outputChannel, {
                sdkManager,
                toolchainManager,
                sysConfigManager,
                serialManager
            }, buildCommand);
            outputChannel.appendLine('  ✅ Webview provider initialized successfully');
            outputChannel.appendLine('');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`Failed to initialize webview provider: ${errorMessage}`);
            throw error;
        }

        // Register all commands
        const commands = [
            // Setup and management commands
            vscode.commands.registerCommand('port11-debugger.setup', () => setupToolchain()),
            vscode.commands.registerCommand('port11-debugger.refreshStatus', () => refreshStatus()),
            vscode.commands.registerCommand('port11-debugger.showPanel', () => webviewProvider.show()),
            vscode.commands.registerCommand('port11-debugger.openSettings', () => openExtensionSettings()),
            vscode.commands.registerCommand('port11-debugger.showLogs', () => outputChannel.show()),

            // Build commands
            vscode.commands.registerCommand('port11-debugger.build', () => buildCommand.execute()),
            vscode.commands.registerCommand('port11-debugger.clean', () => buildCommand.execute({ clean: true })),

            // Status bar build command
            vscode.commands.registerCommand("extension.buildCommand", () => {
                vscode.window.showInformationMessage("Build command triggered!");
                buildCommand.execute();
            }),

            // Flash commands
            vscode.commands.registerCommand('port11-debugger.flash', () => flashCommand.execute()),

            // Debug commands
            vscode.commands.registerCommand('port11-debugger.debug.start', (port?: string) => debugCommand.start(port)),
            vscode.commands.registerCommand('port11-debugger.debug.stop', () => debugCommand.stop()),
            vscode.commands.registerCommand('port11-debugger.debug.pause', () => debugCommand.halt()),
            vscode.commands.registerCommand('port11-debugger.debug.resume', () => debugCommand.resume()),
            vscode.commands.registerCommand('port11-debugger.debug.restart', () => restartDebugSession(debugCommand)),

            // Board management commands
            vscode.commands.registerCommand('port11-debugger.detectBoards', () => detectBoards()),
            vscode.commands.registerCommand('port11-debugger.openMainPanel', async () => {
                outputChannel.appendLine('🚀 Creating standalone Port11 Debugger panel...');
                
                try {
                    // Create a webview panel
                    const panel = vscode.window.createWebviewPanel(
                        'port11MainPanel',
                        'Port11 Debugger - Main Panel',
                        vscode.ViewColumn.One,
                        {
                            enableScripts: true,
                            retainContextWhenHidden: true,
                            localResourceRoots: [
                                context.extensionUri,
                                vscode.Uri.joinPath(context.extensionUri, 'resources')
                            ]
                        }
                    );

                    // Set the HTML content
                    const scriptUri = panel.webview.asWebviewUri(
                        vscode.Uri.joinPath(context.extensionUri, 'resources', 'webview', 'main.js')
                    );
                    const styleUri = panel.webview.asWebviewUri(
                        vscode.Uri.joinPath(context.extensionUri, 'resources', 'webview', 'main.css')
                    );

                    // Try to load HTML template
                    let htmlContent: string;
                    try {
                        const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'webview', 'main.html');
                        const htmlBytes = await vscode.workspace.fs.readFile(htmlPath);
                        htmlContent = Buffer.from(htmlBytes).toString('utf8');
                        
                        // Replace template placeholders
                        htmlContent = htmlContent.replace(/\{\{styleUri\}\}/g, styleUri.toString());
                        htmlContent = htmlContent.replace(/\{\{scriptUri\}\}/g, scriptUri.toString());
                        
                        outputChannel.appendLine('✅ HTML template loaded from file');
                    } catch (error) {
                        outputChannel.appendLine(`⚠️ Could not load HTML template: ${error}`);
                        
                        // Use fallback HTML with full interface
                        htmlContent = /*html*/ `
                        <!DOCTYPE html>
                        <html lang="en">
                        <head>
                            <meta charset="UTF-8">
                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                            <title>Port11 Debugger</title>
                            <link href="${styleUri}" rel="stylesheet">
                            <style>
                                body { 
                                    font-family: var(--vscode-font-family); 
                                    padding: 20px; 
                                    color: var(--vscode-foreground);
                                    background-color: var(--vscode-editor-background);
                                }
                                .section { 
                                    margin-bottom: 30px; 
                                    padding: 20px; 
                                    background: var(--vscode-input-background); 
                                    border: 1px solid var(--vscode-input-border); 
                                    border-radius: 8px; 
                                }
                                .action-btn {
                                    padding: 12px 24px;
                                    margin: 8px;
                                    background: var(--vscode-button-background);
                                    color: var(--vscode-button-foreground);
                                    border: none;
                                    border-radius: 6px;
                                    cursor: pointer;
                                    font-size: 14px;
                                }
                                .action-btn:hover:not(:disabled) {
                                    background: var(--vscode-button-hoverBackground);
                                }
                                .action-btn:disabled {
                                    opacity: 0.6;
                                    cursor: not-allowed;
                                }
                                .status-item {
                                    display: flex;
                                    align-items: center;
                                    padding: 15px;
                                    margin: 10px 0;
                                    background: var(--vscode-list-hoverBackground);
                                    border-radius: 6px;
                                }
                                .status-icon {
                                    font-size: 24px;
                                    margin-right: 15px;
                                }
                                .progress-container {
                                    margin: 20px 0;
                                    padding: 15px;
                                    background: var(--vscode-input-background);
                                    border-radius: 6px;
                                    display: none;
                                }
                                .progress-bar {
                                    width: 100%;
                                    height: 8px;
                                    background: var(--vscode-input-background);
                                    border-radius: 4px;
                                    overflow: hidden;
                                    margin: 10px 0;
                                }
                                .progress-fill {
                                    height: 100%;
                                    background: var(--vscode-progressBar-background);
                                    transition: width 0.3s ease;
                                    width: 0%;
                                }
                                #footer-status {
                                    position: fixed;
                                    bottom: 20px;
                                    right: 20px;
                                    padding: 10px 15px;
                                    background: var(--vscode-badge-background);
                                    color: var(--vscode-badge-foreground);
                                    border-radius: 15px;
                                    font-size: 12px;
                                }
                            </style>
                        </head>
                        <body>
                            <div class="container">
                                <header style="text-align: center; margin-bottom: 40px;">
                                    <h1 style="font-size: 28px; margin-bottom: 10px;">🚀 Port11 Debugger</h1>
                                    <p style="color: var(--vscode-descriptionForeground); font-size: 16px;">MSPM0 Development Environment</p>
                                </header>

                                <div class="section">
                                    <h2>📊 System Status</h2>
                                    <div id="status-grid">
                                        <div class="status-item" id="status-sdk">
                                            <div class="status-icon">📦</div>
                                            <div>
                                                <h3 style="margin: 0 0 5px 0;">MSPM0 SDK</h3>
                                                <p id="sdk-status-text" style="margin: 0; color: var(--vscode-descriptionForeground);">Checking...</p>
                                                <small id="sdk-version" style="color: var(--vscode-descriptionForeground);"></small>
                                            </div>
                                        </div>

                                        <div class="status-item" id="status-toolchain">
                                            <div class="status-icon">🔧</div>
                                            <div>
                                                <h3 style="margin: 0 0 5px 0;">ARM-CGT-CLANG</h3>
                                                <p id="toolchain-status-text" style="margin: 0; color: var(--vscode-descriptionForeground);">Checking...</p>
                                                <small id="toolchain-version" style="color: var(--vscode-descriptionForeground);"></small>
                                            </div>
                                        </div>

                                        <div class="status-item" id="status-board">
                                            <div class="status-icon">🔌</div>
                                            <div>
                                                <h3 style="margin: 0 0 5px 0;">Connected Boards</h3>
                                                <p id="board-status-text" style="margin: 0; color: var(--vscode-descriptionForeground);">Checking...</p>
                                                <small id="board-count" style="color: var(--vscode-descriptionForeground);"></small>
                                            </div>
                                        </div>
                                    </div>
                                    
                                    <div id="setup-progress" class="progress-container">
                                        <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                                            <h3 id="progress-title">Setting up...</h3>
                                            <span id="progress-percentage">0%</span>
                                        </div>
                                        <div class="progress-bar">
                                            <div id="progress-fill" class="progress-fill"></div>
                                        </div>
                                        <p id="progress-text" style="margin: 10px 0 0 0; color: var(--vscode-descriptionForeground);">Initializing...</p>
                                    </div>
                                </div>

                                <div class="section">
                                    <h2>⚡ Quick Actions</h2>
                                    <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                                        <button id="setup-btn" class="action-btn">🔧 Setup Toolchain</button>
                                        <button id="build-btn" class="action-btn" disabled>🔨 Build Project</button>
                                        <button id="flash-btn" class="action-btn" disabled>⚡ Flash Firmware</button>
                                        <button id="debug-btn" class="action-btn" disabled>🐛 Start Debug</button>
                                    </div>
                                </div>

                                <div class="section">
                                    <h2>🔌 Board Management</h2>
                                    <button id="detect-boards-btn" class="action-btn">🔍 Detect Boards</button>
                                    <div id="boards-list" style="margin-top: 15px;">
                                        <p style="text-align: center; color: var(--vscode-descriptionForeground); padding: 20px;">
                                            Click "Detect Boards" to scan for connected devices
                                        </p>
                                    </div>
                                </div>

                                <div id="debug-section" class="section" style="display: none;">
                                    <h2>🐛 Debug Controls</h2>
                                    <div style="display: flex; gap: 10px; margin-bottom: 20px;">
                                        <button id="debug-halt-btn" class="action-btn" disabled>⏸️ Halt</button>
                                        <button id="debug-resume-btn" class="action-btn" disabled>▶️ Resume</button>
                                        <button id="debug-stop-btn" class="action-btn" disabled>⏹️ Stop</button>
                                    </div>
                                    <div id="registers-list">
                                        <p style="text-align: center; color: var(--vscode-descriptionForeground); padding: 20px;">
                                            No debug session active
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <div id="footer-status">Ready</div>

                            <script>
                                const vscode = acquireVsCodeApi();
                                console.log('🚀 Port11 Debugger panel loaded');
                                
                                // Set up event listeners
                                document.getElementById('setup-btn').addEventListener('click', () => {
                                    console.log('Setup button clicked');
                                    vscode.postMessage({ command: 'startSetup' });
                                    showProgress('Starting setup...');
                                });
                                
                                document.getElementById('build-btn').addEventListener('click', () => {
                                    console.log('Build button clicked');
                                    vscode.postMessage({ command: 'buildProject' });
                                });
                                
                                document.getElementById('flash-btn').addEventListener('click', () => {
                                    console.log('Flash button clicked');
                                    vscode.postMessage({ command: 'flashFirmware' });
                                });
                                
                                document.getElementById('debug-btn').addEventListener('click', () => {
                                    console.log('Debug button clicked');
                                    vscode.postMessage({ command: 'startDebug' });
                                });
                                
                                document.getElementById('detect-boards-btn').addEventListener('click', () => {
                                    console.log('Detect boards clicked');
                                    vscode.postMessage({ command: 'detectBoards' });
                                    updateFooterStatus('Detecting boards...');
                                });
                                
                                // Helper functions
                                function showProgress(message) {
                                    const progressContainer = document.getElementById('setup-progress');
                                    const progressText = document.getElementById('progress-text');
                                    
                                    if (progressContainer && progressText) {
                                        progressContainer.style.display = 'block';
                                        progressText.textContent = message;
                                    }
                                }
                                
                                function updateFooterStatus(status) {
                                    const footer = document.getElementById('footer-status');
                                    if (footer) {
                                        footer.textContent = status;
                                    }
                                }
                                
                                // Request initial status
                                vscode.postMessage({ command: 'getStatus' });
                                updateFooterStatus('Panel loaded - Ready');
                                
                                // Listen for messages from extension
                                window.addEventListener('message', event => {
                                    const message = event.data;
                                    console.log('📨 Received message:', message);
                                    
                                    switch (message.command) {
                                        case 'updateStatus':
                                            console.log('Status updated:', message.data);
                                            break;
                                        case 'setupProgress':
                                            if (message.data) {
                                                updateSetupProgress(message.data.progress, message.data.message);
                                            }
                                            break;
                                        case 'setupComplete':
                                            hideProgress();
                                            updateFooterStatus('Setup complete!');
                                            break;
                                        case 'error':
                                            updateFooterStatus('Error: ' + message.data?.message);
                                            break;
                                    }
                                });
                                
                                function updateSetupProgress(percentage, message) {
                                    const progressFill = document.getElementById('progress-fill');
                                    const progressText = document.getElementById('progress-text');
                                    const progressPercentage = document.getElementById('progress-percentage');
                                    
                                    if (progressFill) progressFill.style.width = percentage + '%';
                                    if (progressText) progressText.textContent = message;
                                    if (progressPercentage) progressPercentage.textContent = percentage + '%';
                                    
                                    showProgress(message);
                                }
                                
                                function hideProgress() {
                                    const progressContainer = document.getElementById('setup-progress');
                                    if (progressContainer) {
                                        progressContainer.style.display = 'none';
                                    }
                                }
                            </script>
                            <script src="${scriptUri}"></script>
                        </body>
                        </html>`;
                    }

                    panel.webview.html = htmlContent;

                    // Handle messages from webview
                    panel.webview.onDidReceiveMessage(
                        async message => {
                            outputChannel.appendLine(`📨 Panel received message: ${message.command}`);
                            
                            try {
                                // Forward messages to the webview provider's message handler
                                // You'll need to make the handleMessage method public or create a forwarder
                                switch (message.command) {
                                    case 'startSetup':
                                        await webviewProvider.startSetup();
                                        break;
                                    case 'detectBoards':
                                        // Call serial manager directly
                                        const boards = await serialManager.detectBoards();
                                        panel.webview.postMessage({
                                            command: 'boardsDetected',
                                            data: { boards }
                                        });
                                        break;
                                    case 'getStatus':
                                        // Get status and send to panel
                                        const sdkInstalled = await sdkManager.isSDKInstalled();
                                        const toolchainInstalled = await toolchainManager.isToolchainInstalled();
                                        panel.webview.postMessage({
                                            command: 'updateStatus',
                                            data: { 
                                                status: { sdkInstalled, toolchainInstalled, boardConnected: false, setupComplete: sdkInstalled && toolchainInstalled }
                                            }
                                        });
                                        break;
                                    case 'build':
                                    case 'buildProject':
                                        outputChannel.appendLine('🔨 Build command triggered from webview');
                                        
                                        // Execute the registered build command
                                        await vscode.commands.executeCommand('port11-debugger.build', message.data || {});
                                        
                                        // Send acknowledgment back to webview
                                        panel.webview.postMessage({
                                            command: 'buildStarted',
                                            data: { timestamp: Date.now() }
                                        });
                                        break;
                                    
                                    case 'cancelBuild':
                                        outputChannel.appendLine('🛑 Cancel build command triggered from webview');
                                        // Note: You'll need to implement cancel functionality in BuildCommand
                                        panel.webview.postMessage({
                                            command: 'buildCancelled',
                                            data: { timestamp: Date.now() }
                                        });
                                        break;
                                    
                                    case 'flash':
                                    case 'flashFirmware':
                                        outputChannel.appendLine('⚡ Flash command triggered from webview');
                                        await vscode.commands.executeCommand('port11-debugger.flash', message.data || {});
                                        break;
                                    
                                    case 'debug':
                                    case 'startDebug':
                                        outputChannel.appendLine('🐛 Debug command triggered from webview');
                                        await vscode.commands.executeCommand('port11-debugger.debug', message.data || {});
                                        break;
                                    
                                    case 'showLogs':
                                        outputChannel.show(true);
                                        break;
                                        
                                    default:
                                        outputChannel.appendLine(`❓ Unknown panel command: ${message.command}`);
                                        // Send error back to webview
                                        panel.webview.postMessage({
                                            command: 'error',
                                            data: { message: `Unknown command: ${message.command}` }
                                        });
                                }
                            } catch (error) {
                                outputChannel.appendLine(`Error handling panel message: ${error}`);
                                panel.webview.postMessage({
                                    command: 'error',
                                    data: { message: String(error) }
                                });
                            }
                        },
                        undefined,
                        context.subscriptions
                    );

                    outputChannel.appendLine('✅ Standalone panel created successfully!');
                    
                } catch (error) {
                    outputChannel.appendLine(`❌ Error creating standalone panel: ${error}`);
                    vscode.window.showErrorMessage(`Failed to create Port11 panel: ${error}`);
                }
            }),
        ];

        // Register webview provider
        const webviewDisposable = vscode.window.registerWebviewViewProvider(
            'port11-debugger.panel', 
            webviewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        );

        // Add all disposables to context
        context.subscriptions.push(
            outputChannel,
            statusBarItem,
            webviewDisposable,
            ...commands
        );

        outputChannel.appendLine(`Successfully registered ${commands.length} commands`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Failed to register commands: ${errorMessage}`);
        throw error;
    }

    // Initialize extension
    try {
        await initializeExtension();
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Extension initialization failed: ${errorMessage}`);
        vscode.window.showErrorMessage(`Port11 Debugger initialization failed: ${errorMessage}`);
    }

    outputChannel.appendLine('Port11 Debugger extension activation completed');
}

export function deactivate() {
    outputChannel?.appendLine('Port11 Debugger extension deactivated');
    statusBarItem?.dispose();
    //sysConfigManager?.uninstallSysConfig?.(); // Optional cleanup
    outputChannel?.dispose();
}

// Command implementations

async function setupToolchain(): Promise<void> {
    try {
        outputChannel.appendLine('Starting complete toolchain setup (SDK + Toolchain + SysConfig)...');
        updateStatusBar('Setting up toolchain...');
        
        // Show webview panel
        webviewProvider.show();
        
        // Start setup process
        await webviewProvider.startSetup();
        
        outputChannel.appendLine('Complete toolchain setup completed successfully');
        updateStatusBar('Setup complete');
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Setup failed: ${errorMessage}`);
        updateStatusBar('Setup failed');
        vscode.window.showErrorMessage(`Port11 Debugger setup failed: ${errorMessage}`);
    }
}

async function refreshStatus(): Promise<void> {
    try {
        outputChannel.appendLine('Refreshing status...');
        updateStatusBar('Refreshing...');
        
        // Check all component statuses
        const sdkInstalled = await sdkManager.isSDKInstalled();
        const sdkVersion = await sdkManager.getSDKVersion();
        
        const toolchainInstalled = await toolchainManager.isToolchainInstalled();
        const toolchainInfo = await toolchainManager.getToolchainInfo();
        
        const sysConfigInstalled = await sysConfigManager.isSysConfigInstalled();
        const sysConfigInfo = await sysConfigManager.getSysConfigInfo();
        
        const boards = await serialManager.detectBoards();
        
        outputChannel.appendLine(`Status refresh complete:`);
        outputChannel.appendLine(`  SDK: ${sdkInstalled ? `installed (${sdkVersion})` : 'not installed'}`);
        outputChannel.appendLine(`  Toolchain: ${toolchainInstalled ? `installed (${toolchainInfo.version})` : 'not installed'}`);
        outputChannel.appendLine(`  SysConfig: ${sysConfigInstalled ? `installed (${sysConfigInfo.version})` : 'not installed'}`);
        outputChannel.appendLine(`  Boards: ${boards.length} detected`);
        
        // Update status bar
        if (sdkInstalled && toolchainInstalled && sysConfigInstalled) {
            updateStatusBar(`Ready (${boards.length} boards)`);
        } else {
            const missing = [];
            if (!sdkInstalled) {missing.push('SDK');}
            if (!toolchainInstalled) {missing.push('Toolchain');}
            if (!sysConfigInstalled) {missing.push('SysConfig');}
            updateStatusBar(`Setup required: ${missing.join(', ')}`);
        }
        
        // Refresh webview if visible
        if (webviewProvider) {
            // Trigger webview status update
            outputChannel.appendLine('Webview status refreshed');
        }
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Status refresh failed: ${errorMessage}`);
        updateStatusBar('Status error');
        vscode.window.showWarningMessage(`Status refresh failed: ${errorMessage}`);
    }
}

async function restartDebugSession(debugCommand: DebugCommand): Promise<void> {
    try {
        outputChannel.appendLine('Restarting debug session...');
        
        // Stop current session if active
        await debugCommand.stop();
        
        // Wait a moment before restarting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Start new session
        await debugCommand.start();
        
        outputChannel.appendLine('Debug session restarted successfully');
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Debug session restart failed: ${errorMessage}`);
        vscode.window.showErrorMessage(`Debug restart failed: ${errorMessage}`);
    }
}

async function detectBoards(): Promise<void> {
    try {
        outputChannel.appendLine('Detecting boards...');
        updateStatusBar('Detecting boards...');
        
        const boards = await serialManager.detectBoards();
        
        outputChannel.appendLine(`Detected ${boards.length} board(s):`);
        boards.forEach((board, index) => {
            outputChannel.appendLine(`  ${index + 1}. ${board.friendlyName} (${board.port})`);
        });
        
        if (boards.length === 0) {
            vscode.window.showInformationMessage('No MSPM0 boards detected. Please check connections and drivers.');
            updateStatusBar('No boards found');
        } else {
            vscode.window.showInformationMessage(`Found ${boards.length} MSPM0 board(s). Check output for details.`);
            updateStatusBar(`${boards.length} boards found`);
        }
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Board detection failed: ${errorMessage}`);
        updateStatusBar('Detection failed');
        vscode.window.showErrorMessage(`Board detection failed: ${errorMessage}`);
    }
}

function openExtensionSettings(): void {
    outputChannel.appendLine('Opening Port11 Debugger settings...');
    vscode.commands.executeCommand('workbench.action.openSettings', 'port11-debugger');
}

function updateStatusBar(text: string): void {
    if (statusBarItem) {
        statusBarItem.text = `$(chip) Port11: ${text}`;
        statusBarItem.tooltip = 'Port11 Debugger - Click to show panel';
        statusBarItem.show();
    }
}

function updateConnectStatusBar(): void {
    if (connectStatusBar) {
        const selectedPort = connectionManager.getSelectedPort();
        const selectedPortInfo = connectionManager.getSelectedPortInfo();

        if (selectedPort) {
            const deviceType = selectedPortInfo?.deviceType !== 'Unknown' && selectedPortInfo?.deviceType
                ? ` (${selectedPortInfo.deviceType})`
                : '';
            connectStatusBar.text = `$(plug) ${selectedPort}${deviceType}`;
            connectStatusBar.tooltip = `Connected to: ${connectionManager.getPortStatusText()}\nClick to change port`;
        } else {
            connectStatusBar.text = "$(plug) Connect";
            connectStatusBar.tooltip = "Connect to a serial port";
        }
    }
}

// Initialization functions

async function initializeExtension(): Promise<void> {
    outputChannel.appendLine('Starting extension initialization...');
    
    // Check if status bar should be enabled
    const enableStatusBar = vscode.workspace.getConfiguration('port11-debugger').get('enableStatusBar', true);
    if (enableStatusBar) {
        updateStatusBar('Initializing...');
    }

    // Check for first-time setup
    await checkFirstTimeSetup();
    
    // Auto-detect boards if enabled
    const autoDetectBoards = vscode.workspace.getConfiguration('port11-debugger').get('autoDetectBoards', true);
    if (autoDetectBoards) {
        try {
            await detectBoards();
        } catch (error) {
            outputChannel.appendLine(`Auto board detection failed: ${error}`);
        }
    }
    
    // Check for updates if enabled
    const checkForUpdates = vscode.workspace.getConfiguration('port11-debugger').get('checkForUpdatesOnStartup', true);
    if (checkForUpdates) {
        checkForExtensionUpdates();
    }

    // Initial status refresh
    await refreshStatus();
    
    outputChannel.appendLine('Extension initialization completed');
}

async function checkFirstTimeSetup(): Promise<void> {
    try {
        // Check if all components are already installed
        const sdkInstalled = await sdkManager.isSDKInstalled();
        const toolchainInstalled = await toolchainManager.isToolchainInstalled();
        const sysConfigInstalled = await sysConfigManager.isSysConfigInstalled();
        
        if (!sdkInstalled || !toolchainInstalled || !sysConfigInstalled) {
            outputChannel.appendLine('First-time setup detected - missing components:');
            if (!sdkInstalled) {outputChannel.appendLine('  - MSPM0 SDK');}
            if (!toolchainInstalled) {outputChannel.appendLine('  - ARM-CGT-CLANG Toolchain');}
            if (!sysConfigInstalled) {outputChannel.appendLine('  - TI SysConfig');}
            
            const showWelcome = vscode.workspace.getConfiguration('port11-debugger').get('showWelcomeOnStartup', true);
            
            if (showWelcome) {
                const missingComponents = [];
                if (!sdkInstalled) {missingComponents.push('SDK');}
                if (!toolchainInstalled) {missingComponents.push('Toolchain');}
                if (!sysConfigInstalled) {missingComponents.push('SysConfig');}
                
                const result = await vscode.window.showInformationMessage(
                    `Port11 Debugger: Setup required for MSPM0 development. Missing: ${missingComponents.join(', ')}. Would you like to set up now?`,
                    { title: 'Setup Now', isCloseAffordance: false },
                    { title: 'Setup Later', isCloseAffordance: false },
                    { title: 'Don\'t Show Again', isCloseAffordance: true }
                );
                
                if (result?.title === 'Setup Now') {
                    await setupToolchain();
                } else if (result?.title === 'Don\'t Show Again') {
                    await vscode.workspace.getConfiguration('port11-debugger').update(
                        'showWelcomeOnStartup', 
                        false, 
                        vscode.ConfigurationTarget.Global
                    );
                }
            }
        } else {
            outputChannel.appendLine('All components already installed, skipping first-time setup');
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`First-time setup check failed: ${errorMessage}`);
    }
}

function checkForExtensionUpdates(): void {
    // This is a placeholder for future update checking functionality
    outputChannel.appendLine('Checking for extension updates... (not implemented yet)');
    
    // Future implementation could:
    // 1. Check VS Code marketplace for newer versions
    // 2. Check GitHub releases for DAP binary updates
    // 3. Check TI website for newer toolchain/SysConfig versions
    // 4. Notify user of available updates
}

// Context and state management

export function getExtensionContext(): vscode.ExtensionContext | undefined {
    // This would need to be properly implemented to store and return context
    return undefined;
}

export function getManagers() {
    return {
        sdkManager,
        toolchainManager,
        sysConfigManager,
        serialManager,
        outputChannel,
        statusBarItem
    };
}

export function getWebviewProvider(): WebviewProvider {
    return webviewProvider;
}

// Error handling and logging utilities

export function logError(error: Error | string, context?: string): void {
    const errorMessage = error instanceof Error ? error.message : error;
    const logMessage = context ? `[${context}] ${errorMessage}` : errorMessage;
    
    outputChannel.appendLine(`ERROR: ${logMessage}`);
    
    if (error instanceof Error && error.stack) {
        outputChannel.appendLine(`Stack trace: ${error.stack}`);
    }
}

export function logWarning(message: string, context?: string): void {
    const logMessage = context ? `[${context}] ${message}` : message;
    outputChannel.appendLine(`WARNING: ${logMessage}`);
}

export function logInfo(message: string, context?: string): void {
    const logLevel = vscode.workspace.getConfiguration('port11-debugger').get('logLevel', 'info');
    
    if (['info', 'debug', 'trace'].includes(logLevel)) {
        const logMessage = context ? `[${context}] ${message}` : message;
        outputChannel.appendLine(`INFO: ${logMessage}`);
    }
}

export function logDebug(message: string, context?: string): void {
    const logLevel = vscode.workspace.getConfiguration('port11-debugger').get('logLevel', 'info');
    
    if (['debug', 'trace'].includes(logLevel)) {
        const logMessage = context ? `[${context}] ${message}` : message;
        outputChannel.appendLine(`DEBUG: ${logMessage}`);
    }
}