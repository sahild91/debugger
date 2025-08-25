import * as vscode from 'vscode';
import * as path from 'path';
import { SDKManager, SDKSetupProgress } from '../managers/sdkManager';
import { ToolchainManager, ToolchainSetupProgress } from '../managers/toolchainManager';
import { SerialManager, BoardInfo } from '../managers/serialManager';

export interface WebviewMessage {
    command: string;
    data?: any;
}

export interface SetupStatus {
    sdkInstalled: boolean;
    toolchainInstalled: boolean;
    boardConnected: boolean;
    setupComplete: boolean;
}

export class WebviewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private sdkManager: SDKManager;
    private toolchainManager: ToolchainManager;
    private serialManager: SerialManager;
    private isSetupInProgress = false;

    constructor(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel,
        managers: {
            sdkManager: SDKManager;
            toolchainManager: ToolchainManager;
            serialManager: SerialManager;
        }
    ) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.sdkManager = managers.sdkManager;
        this.toolchainManager = managers.toolchainManager;
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
                this.context.extensionUri
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

            case 'detectBoards':
                await this.detectBoards();
                break;

            case 'connectBoard':
                await this.connectToBoard(message.data?.port);
                break;

            case 'disconnectBoard':
                await this.disconnectFromBoard(message.data?.port);
                break;

            case 'refreshStatus':
                await this.updateSetupStatus();
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

    public async startSetup(): Promise<void> {
        if (this.isSetupInProgress) {
            this.outputChannel.appendLine('Setup already in progress');
            return;
        }

        this.isSetupInProgress = true;
        
        try {
            this.sendMessage({
                command: 'setupStarted',
                data: { message: 'Starting setup process...' }
            });

            // Check current status
            const sdkInstalled = await this.sdkManager.isSDKInstalled();
            const toolchainInstalled = await this.toolchainManager.isToolchainInstalled();

            // Install SDK if needed
            if (!sdkInstalled) {
                await this.installSDK();
            }

            // Install toolchain if needed  
            if (!toolchainInstalled) {
                await this.installToolchain();
            }

            // Update final status
            await this.updateSetupStatus();

            this.sendMessage({
                command: 'setupComplete',
                data: { message: 'Setup completed successfully!' }
            });

            // Mark setup as complete in settings
            const config = vscode.workspace.getConfiguration('port11-debugger');
            await config.update('setupComplete', true, vscode.ConfigurationTarget.Global);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Setup failed: ${errorMessage}`);
            
            this.sendMessage({
                command: 'setupError',
                data: { message: `Setup failed: ${errorMessage}` }
            });
        } finally {
            this.isSetupInProgress = false;
        }
    }

    private async installSDK(): Promise<void> {
        this.sendMessage({
            command: 'sdkInstallStarted',
            data: { message: 'Installing MSPM0 SDK...' }
        });

        await this.sdkManager.installSDK((progress: SDKSetupProgress) => {
            this.sendMessage({
                command: 'sdkProgress',
                data: progress
            });
        });

        this.sendMessage({
            command: 'sdkInstallComplete',
            data: { message: 'MSPM0 SDK installation complete' }
        });
    }

    private async installToolchain(): Promise<void> {
        this.sendMessage({
            command: 'toolchainInstallStarted', 
            data: { message: 'Installing ARM-CGT-CLANG toolchain...' }
        });

        await this.toolchainManager.installToolchain((progress: ToolchainSetupProgress) => {
            this.sendMessage({
                command: 'toolchainProgress',
                data: progress
            });
        });

        this.sendMessage({
            command: 'toolchainInstallComplete',
            data: { message: 'ARM-CGT-CLANG toolchain installation complete' }
        });
    }

    private async detectBoards(): Promise<void> {
        try {
            const boards = await this.serialManager.detectBoards();
            
            this.sendMessage({
                command: 'boardsDetected',
                data: { boards }
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Board detection failed: ${errorMessage}`);
            
            this.sendMessage({
                command: 'boardDetectionError',
                data: { message: errorMessage }
            });
        }
    }

    private async connectToBoard(port: string): Promise<void> {
        if (!port) {
            throw new Error('No port specified for board connection');
        }

        try {
            await this.serialManager.connectToBoard(port);
            
            this.sendMessage({
                command: 'boardConnected',
                data: { port, message: `Connected to ${port}` }
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Board connection failed: ${errorMessage}`);
            
            this.sendMessage({
                command: 'boardConnectionError',
                data: { port, message: errorMessage }
            });
        }
    }

    private async disconnectFromBoard(port: string): Promise<void> {
        if (!port) {
            throw new Error('No port specified for board disconnection');
        }

        try {
            await this.serialManager.disconnectFromBoard(port);
            
            this.sendMessage({
                command: 'boardDisconnected',
                data: { port, message: `Disconnected from ${port}` }
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Board disconnection failed: ${errorMessage}`);
            
            this.sendMessage({
                command: 'boardDisconnectionError',
                data: { port, message: errorMessage }
            });
        }
    }

    private async updateSetupStatus(): Promise<void> {
        try {
            const sdkInstalled = await this.sdkManager.isSDKInstalled();
            const toolchainInstalled = await this.toolchainManager.isToolchainInstalled();
            const boards = await this.serialManager.detectBoards();
            const connectedPorts = this.serialManager.getConnectedPorts();

            const status: SetupStatus = {
                sdkInstalled,
                toolchainInstalled,
                boardConnected: connectedPorts.length > 0,
                setupComplete: sdkInstalled && toolchainInstalled
            };

            // Get version information
            const sdkVersion = await this.sdkManager.getSDKVersion();
            const toolchainInfo = await this.toolchainManager.getToolchainInfo();

            this.sendMessage({
                command: 'statusUpdate',
                data: {
                    status,
                    sdkVersion,
                    toolchainInfo,
                    boards,
                    connectedPorts
                }
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Status update failed: ${errorMessage}`);
            
            this.sendMessage({
                command: 'statusError',
                data: { message: errorMessage }
            });
        }
    }

    private getWebviewContent(): string {
        const scriptUri = this.view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'webview', 'main.js')
        );
        const styleUri = this.view?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'webview', 'main.css')
        );

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Port11 Debugger</title>
            <link href="${styleUri}" rel="stylesheet">
        </head>
        <body>
            <div class="container">
                <header>
                    <h1>Port11 Debugger</h1>
                    <p>MSPM0 Development Environment</p>
                </header>

                <section id="status-section" class="section">
                    <h2>System Status</h2>
                    <div id="status-grid" class="status-grid">
                        <div class="status-item" id="sdk-status">
                            <div class="status-icon" id="sdk-icon">⏳</div>
                            <div class="status-content">
                                <h3>MSPM0 SDK</h3>
                                <p id="sdk-text">Checking...</p>
                            </div>
                        </div>
                        
                        <div class="status-item" id="toolchain-status">
                            <div class="status-icon" id="toolchain-icon">⏳</div>
                            <div class="status-content">
                                <h3>ARM-CGT-CLANG</h3>
                                <p id="toolchain-text">Checking...</p>
                            </div>
                        </div>
                        
                        <div class="status-item" id="board-status">
                            <div class="status-icon" id="board-icon">⏳</div>
                            <div class="status-content">
                                <h3>Board Connection</h3>
                                <p id="board-text">Checking...</p>
                            </div>
                        </div>
                    </div>
                </section>

                <section id="setup-section" class="section">
                    <h2>Setup</h2>
                    <div class="button-group">
                        <button id="start-setup-btn" class="btn btn-primary">Start Setup</button>
                        <button id="refresh-btn" class="btn btn-secondary">Refresh Status</button>
                    </div>
                    
                    <div id="setup-progress" class="progress-container" style="display: none;">
                        <div class="progress-bar">
                            <div id="progress-fill" class="progress-fill"></div>
                        </div>
                        <p id="progress-text">Starting setup...</p>
                    </div>
                </section>

                <section id="boards-section" class="section">
                    <h2>Connected Boards</h2>
                    <div class="button-group">
                        <button id="detect-boards-btn" class="btn btn-secondary">Detect Boards</button>
                    </div>
                    <div id="boards-list" class="boards-list">
                        <p>Click "Detect Boards" to scan for connected devices</p>
                    </div>
                </section>

                <section id="actions-section" class="section">
                    <h2>Actions</h2>
                    <div class="button-group">
                        <button id="build-btn" class="btn btn-primary" disabled>Build Project</button>
                        <button id="flash-btn" class="btn btn-primary" disabled>Flash Firmware</button>
                        <button id="debug-btn" class="btn btn-primary" disabled>Start Debug</button>
                    </div>
                </section>

                <footer>
                    <p id="footer-status">Ready</p>
                </footer>
            </div>

            <script src="${scriptUri}"></script>
        </body>
        </html>`;
    }
}