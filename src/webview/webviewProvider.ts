import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SDKManager, SDKSetupProgress } from '../managers/sdkManager';
import { ToolchainManager, ToolchainSetupProgress } from '../managers/toolchainManager';
import { SysConfigManager, SysConfigSetupProgress } from '../managers/sysconfigManager';
import { SerialManager, BoardInfo } from '../managers/serialManager';

export interface WebviewMessage {
    command: string;
    data?: any;
}

export interface SetupStatus {
    sdkInstalled: boolean;
    toolchainInstalled: boolean;
    sysConfigInstalled: boolean;
    boardConnected: boolean;
    setupComplete: boolean;
}

export class WebviewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private sdkManager: SDKManager;
    private toolchainManager: ToolchainManager;
    private sysConfigManager: SysConfigManager;
    private serialManager: SerialManager;
    private isSetupInProgress = false;

    constructor(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel,
        managers: {
            sdkManager: SDKManager;
            toolchainManager: ToolchainManager;
            sysConfigManager: SysConfigManager;
            serialManager: SerialManager;
        }
    ) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.sdkManager = managers.sdkManager;
        this.toolchainManager = managers.toolchainManager;
        this.sysConfigManager = managers.sysConfigManager;
        this.serialManager = managers.serialManager;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken
    ) {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this.context.extensionUri,
                vscode.Uri.joinPath(this.context.extensionUri, 'resources')
            ]
        };

        webviewView.webview.html = this.getWebviewContent();
        this.setupMessageHandlers();
        
        // Initialize the view with current status
        this.updateSetupStatus();
    }

    public show(): void {
        if (this.view) {
            this.view.show?.(true);
        }
    }

    private setupMessageHandlers(): void {
        if (!this.view) return;

        this.view.webview.onDidReceiveMessage(
            async (message: WebviewMessage) => {
                try {
                    await this.handleMessage(message);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    this.outputChannel.appendLine(`Webview message handler error: ${errorMessage}`);
                    this.sendMessage({
                        command: 'error',
                        data: { message: errorMessage }
                    });
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        this.outputChannel.appendLine(`Received webview message: ${message.command}`);

        switch (message.command) {
            case 'getStatus':
                await this.updateSetupStatus();
                break;

            case 'startSetup':
                await this.startSetup();
                break;

            case 'installSDK':
                await this.installSDK();
                break;

            case 'installToolchain':
                await this.installToolchain();
                break;

            case 'installSysConfig':
                await this.installSysConfig();
                break;

            case 'detectBoards':
                await this.detectBoards();
                break;

            case 'connectBoard':
                await this.connectToBoard(message.data?.port);
                break;

            case 'disconnectBoard':
                await this.disconnectFromBoard(message.data?.port);
                break;

            case 'buildProject':
                await this.buildProject();
                break;

            case 'flashFirmware':
                await this.flashFirmware();
                break;

            case 'startDebug':
                await this.startDebug();
                break;

            case 'haltDebug':
                await this.haltDebug();
                break;

            case 'resumeDebug':
                await this.resumeDebug();
                break;

            case 'stopDebug':
                await this.stopDebug();
                break;

            case 'refreshStatus':
                await this.updateSetupStatus();
                break;

            case 'openSettings':
                await this.openExtensionSettings();
                break;

            case 'showLogs':
                this.outputChannel.show();
                break;

            case 'log':
                this.handleClientLog(message.data);
                break;

            default:
                this.outputChannel.appendLine(`Unknown webview command: ${message.command}`);
        }
    }

    private sendMessage(message: WebviewMessage): void {
        if (this.view) {
            this.view.webview.postMessage(message);
        }
    }

    // Setup and Installation Methods

    public async startSetup(): Promise<void> {
        if (this.isSetupInProgress) {
            this.sendMessage({
                command: 'setupError',
                data: { error: 'Setup already in progress' }
            });
            return;
        }

        this.isSetupInProgress = true;

        try {
            this.outputChannel.appendLine('='.repeat(50));
            this.outputChannel.appendLine('Starting Port11 Debugger complete setup...');
            this.outputChannel.appendLine('Components: SDK + Toolchain + SysConfig');
            this.outputChannel.appendLine('='.repeat(50));

            // Send initial progress
            this.sendMessage({
                command: 'setupProgress',
                data: {
                    stage: 'initializing',
                    progress: 0,
                    message: 'Initializing setup process...'
                }
            });

            // Check current installation status
            const sdkInstalled = await this.sdkManager.isSDKInstalled();
            const toolchainInstalled = await this.toolchainManager.isToolchainInstalled();
            const sysConfigInstalled = await this.sysConfigManager.isSysConfigInstalled();

            this.outputChannel.appendLine(`Current status:`);
            this.outputChannel.appendLine(`  SDK=${sdkInstalled}`);
            this.outputChannel.appendLine(`  Toolchain=${toolchainInstalled}`);
            this.outputChannel.appendLine(`  SysConfig=${sysConfigInstalled}`);

            let currentProgress = 5;

            // Install SDK if needed (Progress: 5-35%)
            if (!sdkInstalled) {
                this.outputChannel.appendLine('SDK not found - starting installation...');
                this.sendMessage({
                    command: 'setupProgress',
                    data: {
                        stage: 'sdk',
                        progress: currentProgress,
                        message: 'Installing MSPM0 SDK...'
                    }
                });

                await this.installSDK();
                currentProgress = 35;
            } else {
                this.outputChannel.appendLine('SDK already installed - skipping SDK installation');
                currentProgress = 35;
            }

            // Install Toolchain if needed (Progress: 35-65%)
            if (!toolchainInstalled) {
                this.outputChannel.appendLine('Toolchain not found - starting installation...');
                this.sendMessage({
                    command: 'setupProgress',
                    data: {
                        stage: 'toolchain',
                        progress: currentProgress,
                        message: 'Installing ARM-CGT-CLANG toolchain...'
                    }
                });

                await this.installToolchain();
                currentProgress = 65;
            } else {
                this.outputChannel.appendLine('Toolchain already installed - skipping toolchain installation');
                currentProgress = 65;
            }

            // Install SysConfig if needed (Progress: 65-90%)
            if (!sysConfigInstalled) {
                this.outputChannel.appendLine('SysConfig not found - starting installation...');
                this.sendMessage({
                    command: 'setupProgress',
                    data: {
                        stage: 'sysconfig',
                        progress: currentProgress,
                        message: 'Installing TI SysConfig...'
                    }
                });

                await this.installSysConfig();
                currentProgress = 90;
            } else {
                this.outputChannel.appendLine('SysConfig already installed - skipping SysConfig installation');
                currentProgress = 90;
            }

            // Final validation (Progress: 90-100%)
            this.sendMessage({
                command: 'setupProgress',
                data: {
                    stage: 'finalizing',
                    progress: 95,
                    message: 'Validating complete installation...'
                }
            });

            // Update final status
            await this.updateSetupStatus();

            this.sendMessage({
                command: 'setupProgress',
                data: {
                    stage: 'complete',
                    progress: 100,
                    message: 'Complete setup finished successfully!'
                }
            });

            this.outputChannel.appendLine('='.repeat(50));
            this.outputChannel.appendLine('Complete setup process finished successfully!');
            this.outputChannel.appendLine('All components: SDK + Toolchain + SysConfig installed');
            this.outputChannel.appendLine('='.repeat(50));

            this.sendMessage({
                command: 'setupComplete',
                data: { message: 'Complete setup finished successfully!' }
            });

            // Mark setup as complete in extension global state
            await this.context.globalState.update('setupComplete', true);
            await this.context.globalState.update('setupCompletedDate', new Date().toISOString());

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Setup failed: ${errorMessage}`);
            
            this.sendMessage({
                command: 'setupError',
                data: { error: errorMessage }
            });

            await this.context.globalState.update('lastSetupError', {
                error: errorMessage,
                date: new Date().toISOString()
            });

        } finally {
            this.isSetupInProgress = false;
        }
    }

    private async installSDK(): Promise<void> {
        try {
            await this.sdkManager.installSDK((progress: SDKSetupProgress) => {
                this.sendMessage({
                    command: 'sdkProgress',
                    data: {
                        stage: progress.stage,
                        progress: progress.progress,
                        message: progress.message
                    }
                });
            });
        } catch (error) {
            throw new Error(`SDK installation failed: ${error}`);
        }
    }

    private async installToolchain(): Promise<void> {
        try {
            await this.toolchainManager.installToolchain((progress: ToolchainSetupProgress) => {
                this.sendMessage({
                    command: 'toolchainProgress',
                    data: {
                        stage: progress.stage,
                        progress: progress.progress,
                        message: progress.message
                    }
                });
            });
        } catch (error) {
            throw new Error(`Toolchain installation failed: ${error}`);
        }
    }

    private async installSysConfig(): Promise<void> {
        try {
            await this.sysConfigManager.installSysConfig((progress: SysConfigSetupProgress) => {
                this.sendMessage({
                    command: 'sysConfigProgress',
                    data: {
                        stage: progress.stage,
                        progress: progress.progress,
                        message: progress.message
                    }
                });
            });
        } catch (error) {
            throw new Error(`SysConfig installation failed: ${error}`);
        }
    }

    // Board Management Methods (unchanged)
    private async detectBoards(): Promise<void> {
        try {
            this.outputChannel.appendLine('Detecting boards...');
            const boards = await this.serialManager.detectBoards();
            
            this.outputChannel.appendLine(`Detected ${boards.length} board(s)`);
            boards.forEach((board, index) => {
                this.outputChannel.appendLine(`  ${index + 1}. ${board.friendlyName} (${board.port})`);
            });

            this.sendMessage({
                command: 'boardsDetected',
                data: { boards }
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Board detection failed: ${errorMessage}`);
            this.sendMessage({
                command: 'error',
                data: { message: `Board detection failed: ${errorMessage}` }
            });
        }
    }

    private async connectToBoard(port?: string): Promise<void> {
        try {
            if (!port) {
                throw new Error('No port specified for connection');
            }

            this.outputChannel.appendLine(`Connecting to board on ${port}...`);
            await this.serialManager.connectToBoard(port);
            
            const boards = await this.serialManager.detectBoards();
            const connectedBoard = boards.find(b => b.port === port);

            if (connectedBoard) {
                this.sendMessage({
                    command: 'boardConnected',
                    data: { board: connectedBoard }
                });
                this.outputChannel.appendLine(`Successfully connected to ${connectedBoard.friendlyName}`);
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Board connection failed: ${errorMessage}`);
            this.sendMessage({
                command: 'error',
                data: { message: `Connection failed: ${errorMessage}` }
            });
        }
    }

    private async disconnectFromBoard(port?: string): Promise<void> {
        try {
            if (!port) {
                throw new Error('No port specified for disconnection');
            }

            this.outputChannel.appendLine(`Disconnecting from board on ${port}...`);
            await this.serialManager.disconnectFromBoard(port);
            
            this.sendMessage({
                command: 'boardDisconnected',
                data: { port }
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Board disconnection failed: ${errorMessage}`);
            this.sendMessage({
                command: 'error',
                data: { message: `Disconnection failed: ${errorMessage}` }
            });
        }
    }

    // Development Operations (placeholders for now)
    private async buildProject(): Promise<void> {
        try {
            this.outputChannel.appendLine('Building project...');
            
            // This will be implemented with the build system
            this.sendMessage({
                command: 'buildComplete',
                data: { success: true, message: 'Build functionality will be implemented next' }
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.sendMessage({
                command: 'buildComplete',
                data: { success: false, error: errorMessage }
            });
        }
    }

    private async flashFirmware(): Promise<void> {
        try {
            this.outputChannel.appendLine('Flashing firmware...');
            
            // This will be implemented with DAP binaries
            this.sendMessage({
                command: 'flashComplete',
                data: { success: true, message: 'Flash functionality will be implemented with DAP binaries' }
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.sendMessage({
                command: 'flashComplete',
                data: { success: false, error: errorMessage }
            });
        }
    }

    // Debug Operations (placeholders for DAP integration)
    private async startDebug(): Promise<void> {
        try {
            this.outputChannel.appendLine('Starting debug session...');
            
            // Placeholder for DAP CLI integration
            this.sendMessage({
                command: 'debugStarted',
                data: { 
                    session: { 
                        id: `debug-${Date.now()}`,
                        status: 'Running' 
                    } 
                }
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.sendMessage({
                command: 'error',
                data: { message: `Debug start failed: ${errorMessage}` }
            });
        }
    }

    private async haltDebug(): Promise<void> {
        this.outputChannel.appendLine('Halting debug session...');
        // Placeholder for DAP CLI halt command
    }

    private async resumeDebug(): Promise<void> {
        this.outputChannel.appendLine('Resuming debug session...');
        // Placeholder for DAP CLI resume command
    }

    private async stopDebug(): Promise<void> {
        try {
            this.outputChannel.appendLine('Stopping debug session...');
            
            // Placeholder for DAP CLI integration
            this.sendMessage({
                command: 'debugStopped',
                data: { message: 'Debug session stopped' }
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.sendMessage({
                command: 'error',
                data: { message: `Debug stop failed: ${errorMessage}` }
            });
        }
    }

    // Status and Utility Methods
    private async updateSetupStatus(): Promise<void> {
        try {
            const sdkInstalled = await this.sdkManager.isSDKInstalled();
            const sdkVersion = await this.sdkManager.getSDKVersion();
            
            const toolchainInfo = await this.toolchainManager.getToolchainInfo();
            const toolchainInstalled = toolchainInfo.isInstalled;
            
            const sysConfigInfo = await this.sysConfigManager.getSysConfigInfo();
            const sysConfigInstalled = sysConfigInfo.isInstalled;
            
            const boards = await this.serialManager.detectBoards();
            const connectedBoards = await this.serialManager.getConnectedMSPM0Boards();
            const boardConnected = connectedBoards.length > 0;
            
            const setupComplete = sdkInstalled && toolchainInstalled && sysConfigInstalled;

            const status: SetupStatus = {
                sdkInstalled,
                toolchainInstalled,
                sysConfigInstalled,
                boardConnected,
                setupComplete
            };

            const statusData = {
                status,
                sdkVersion,
                toolchainInfo,
                sysConfigInfo,
                connectedPorts: connectedBoards,
                availableBoards: boards
            };

            this.sendMessage({
                command: 'updateStatus',
                data: statusData
            });

            this.outputChannel.appendLine(`Status updated:`);
            this.outputChannel.appendLine(`  SDK=${sdkInstalled}, Toolchain=${toolchainInstalled}, SysConfig=${sysConfigInstalled}`);
            this.outputChannel.appendLine(`  Boards=${boards.length}, Connected=${connectedBoards.length}`);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Status update failed: ${errorMessage}`);
            this.sendMessage({
                command: 'error',
                data: { message: `Status update failed: ${errorMessage}` }
            });
        }
    }

    private async openExtensionSettings(): Promise<void> {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'port11-debugger');
    }

    private handleClientLog(data: any): void {
        if (data && data.message) {
            const level = data.level || 'info';
            const message = data.message;
            this.outputChannel.appendLine(`[WebView ${level.toUpperCase()}] ${message}`);
        }
    }

    // Template and Content Methods

    private getWebviewContent(): string {
        const scriptUri = this.view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'webview', 'main.js')
        );
        const styleUri = this.view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'webview', 'main.css')
        );

        // Try to load HTML template from file, fall back to inline template
        let htmlContent = this.loadHTMLTemplate();
        
        // Replace template placeholders
        htmlContent = htmlContent.replace(/\{\{styleUri\}\}/g, styleUri?.toString() || '');
        htmlContent = htmlContent.replace(/\{\{scriptUri\}\}/g, scriptUri?.toString() || '');

        return htmlContent;
    }

    private loadHTMLTemplate(): string {
        try {
            const templatePath = path.join(this.context.extensionPath, 'resources', 'webview', 'main.html');
            
            if (fs.existsSync(templatePath)) {
                return fs.readFileSync(templatePath, 'utf8');
            } else {
                this.outputChannel.appendLine(`HTML template not found at ${templatePath}, using fallback`);
                return this.getFallbackHTML();
            }
        } catch (error) {
            this.outputChannel.appendLine(`Error loading HTML template: ${error}`);
            return this.getFallbackHTML();
        }
    }

    private getFallbackHTML(): string {
        // Enhanced fallback HTML content with SysConfig status
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src {{styleUri}} 'unsafe-inline'; script-src {{scriptUri}} 'unsafe-inline';">
            <title>Port11 Debugger</title>
            <link href="{{styleUri}}" rel="stylesheet">
            <style>
                body { 
                    font-family: var(--vscode-font-family); 
                    padding: 16px; 
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                }
                .container { max-width: 800px; margin: 0 auto; }
                .section { margin-bottom: 24px; padding: 16px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; }
                .section h2 { margin-bottom: 16px; font-size: 18px; font-weight: 600; }
                .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; }
                .status-item { display: flex; align-items: center; padding: 12px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
                .btn { padding: 8px 16px; margin: 4px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; }
                .btn:disabled { opacity: 0.6; cursor: not-allowed; }
                .btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
                .progress-container { margin-top: 16px; }
                .progress-bar { width: 100%; height: 8px; background: var(--vscode-input-background); border-radius: 4px; overflow: hidden; }
                .progress-fill { height: 100%; background: var(--vscode-progressBar-background); transition: width 0.3s ease; width: 0%; }
                .empty-state { text-align: center; padding: 32px; color: var(--vscode-descriptionForeground); }
                #footer-status { text-align: center; padding: 16px; font-size: 14px; color: var(--vscode-descriptionForeground); }
            </style>
        </head>
        <body>
            <div class="container">
                <header style="text-align: center; margin-bottom: 32px; padding-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border);">
                    <h1 style="font-size: 24px; margin-bottom: 8px;">Port11 Debugger</h1>
                    <p style="color: var(--vscode-descriptionForeground);">MSPM0 Development Environment</p>
                </header>

                <section class="section">
                    <h2>System Status</h2>
                    <div class="status-grid">
                        <div class="status-item" id="status-sdk">
                            <div style="margin-right: 12px;">📦</div>
                            <div>
                                <h3 style="margin: 0 0 4px 0; font-size: 14px;">MSPM0 SDK</h3>
                                <p id="sdk-status-text" style="margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground);">Checking...</p>
                                <small id="sdk-version" style="font-size: 11px; color: var(--vscode-descriptionForeground);"></small>
                            </div>
                        </div>

                        <div class="status-item" id="status-toolchain">
                            <div style="margin-right: 12px;">🔧</div>
                            <div>
                                <h3 style="margin: 0 0 4px 0; font-size: 14px;">ARM-CGT-CLANG</h3>
                                <p id="toolchain-status-text" style="margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground);">Checking...</p>
                                <small id="toolchain-version" style="font-size: 11px; color: var(--vscode-descriptionForeground);"></small>
                            </div>
                        </div>

                        <div class="status-item" id="status-sysconfig">
                            <div style="margin-right: 12px;">⚙️</div>
                            <div>
                                <h3 style="margin: 0 0 4px 0; font-size: 14px;">TI SysConfig</h3>
                                <p id="sysconfig-status-text" style="margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground);">Checking...</p>
                                <small id="sysconfig-version" style="font-size: 11px; color: var(--vscode-descriptionForeground);"></small>
                            </div>
                        </div>

                        <div class="status-item" id="status-board">
                            <div style="margin-right: 12px;">🔌</div>
                            <div>
                                <h3 style="margin: 0 0 4px 0; font-size: 14px;">Boards</h3>
                                <p id="board-status-text" style="margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground);">Checking...</p>
                                <small id="board-count" style="font-size: 11px; color: var(--vscode-descriptionForeground);"></small>
                            </div>
                        </div>
                    </div>
                    
                    <div id="setup-progress" class="progress-container" style="display: none;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <h3 id="progress-title" style="margin: 0; font-size: 14px;">Setting up...</h3>
                            <span id="progress-percentage" style="font-size: 12px; font-weight: 600;">0%</span>
                        </div>
                        <div class="progress-bar">
                            <div id="progress-fill" class="progress-fill"></div>
                        </div>
                        <p id="progress-text" style="margin: 8px 0 0 0; font-size: 12px; color: var(--vscode-descriptionForeground);">Initializing...</p>
                    </div>
                </section>

                <section class="section">
                    <h2>Quick Actions</h2>
                    <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                        <button id="setup-btn" class="btn">Complete Setup (SDK + Toolchain + SysConfig)</button>
                        <button id="build-btn" class="btn" disabled>Build Project</button>
                        <button id="flash-btn" class="btn" disabled>Flash Firmware</button>
                        <button id="debug-btn" class="btn" disabled>Start Debug</button>
                    </div>
                </section>

                <section class="section">
                    <h2>Connected Boards</h2>
                    <button id="detect-boards-btn" class="btn">Detect Boards</button>
                    <div id="boards-list" class="empty-state" style="margin-top: 16px;">
                        <p>Click "Detect Boards" to scan for connected devices</p>
                    </div>
                </section>

                <div id="debug-section" class="section" style="display: none;">
                    <h2>Debug Controls</h2>
                    <div style="display: flex; gap: 8px; margin-bottom: 16px;">
                        <button id="debug-halt-btn" class="btn" disabled>Halt</button>
                        <button id="debug-resume-btn" class="btn" disabled>Resume</button>
                        <button id="debug-stop-btn" class="btn" disabled>Stop</button>
                    </div>
                    <div id="registers-list" class="empty-state">
                        <p>No debug session active</p>
                    </div>
                </section>

                <footer>
                    <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border);">
                        <span id="footer-status">Ready</span>
                        <div>
                            <button id="refresh-status-btn" class="btn" style="padding: 4px 8px; margin: 0 4px;">🔄</button>
                            <button id="settings-btn" class="btn" style="padding: 4px 8px; margin: 0 4px;">⚙️</button>
                            <button id="logs-btn" class="btn" style="padding: 4px 8px; margin: 0 4px;">📄</button>
                        </div>
                    </div>
                </footer>
            </div>

            <script src="{{scriptUri}}"></script>
        </body>
        </html>`;
    }

    // Utility methods for setup state management

    private async isSetupComplete(): Promise<boolean> {
        try {
            const sdkInstalled = await this.sdkManager.isSDKInstalled();
            const toolchainInstalled = await this.toolchainManager.isToolchainInstalled();
            const sysConfigInstalled = await this.sysConfigManager.isSysConfigInstalled();
            
            return sdkInstalled && toolchainInstalled && sysConfigInstalled;
        } catch (error) {
            this.outputChannel.appendLine(`Error checking setup status: ${error}`);
            return false;
        }
    }

    private async getSetupCompletedDate(): Promise<string | undefined> {
        return this.context.globalState.get('setupCompletedDate');
    }

    private async getLastSetupError(): Promise<{ error: string; date: string } | undefined> {
        return this.context.globalState.get('lastSetupError');
    }

    // Public methods for external access

    public async refresh(): Promise<void> {
        await this.updateSetupStatus();
    }

    public getSetupInProgress(): boolean {
        return this.isSetupInProgress;
    }

    public async getSetupInfo(): Promise<{
        isComplete: boolean;
        completedDate?: string;
        lastError?: { error: string; date: string };
        sdkInstalled: boolean;
        toolchainInstalled: boolean;
        sysConfigInstalled: boolean;
    }> {
        const isComplete = await this.isSetupComplete();
        const completedDate = await this.getSetupCompletedDate();
        const lastError = await this.getLastSetupError();
        const sdkInstalled = await this.sdkManager.isSDKInstalled();
        const toolchainInstalled = await this.toolchainManager.isToolchainInstalled();
        const sysConfigInstalled = await this.sysConfigManager.isSysConfigInstalled();

        return {
            isComplete,
            completedDate,
            lastError,
            sdkInstalled,
            toolchainInstalled,
            sysConfigInstalled
        };
    }
}