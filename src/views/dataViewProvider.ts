import * as vscode from "vscode";
import { spawn } from "child_process";

export interface RegisterData {
  name: string;
  value: string;
  description?: string;
}

/**
 * DataViewProvider manages the data webview panel
 * Displays registry data from swd-debugger read-all command
 */
export class DataViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private outputChannel: vscode.OutputChannel;
  private swdDebuggerPath: string;
  private registryData: RegisterData[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    outputChannel: vscode.OutputChannel,
    swdDebuggerPath: string
  ) {
    this.outputChannel = outputChannel;
    this.swdDebuggerPath = swdDebuggerPath;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview();

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.type === "refresh") {
        this.updateRegistryData();
      }
    });

    // Initial render
    this.refresh();
  }

  /**
   * Update registry data by executing swd-debugger read-all
   */
  public async updateRegistryData(): Promise<void> {
    try {
      this.outputChannel.appendLine('📊 Reading registry data...');
      const output = await this.executeSwdCommand(['read-all']);
      console.log('Registry output:', output);
      // Parse the output
      this.registryData = this.parseRegistryOutput(output);

      this.outputChannel.appendLine(`✅ Registry data updated: ${this.registryData.length} registers`);
      this.refresh();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`❌ Failed to read registry data: ${errorMsg}`);
      this.registryData = [];
      this.refresh();
    }
  }

  /**
   * Parse registry output from swd-debugger read-all
   */
  private parseRegistryOutput(output: string): RegisterData[] {
    const registers: RegisterData[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // Try to match format: "R0: 0x12345678" or "PC: 0x08000000"
      const match = line.match(/([A-Z0-9_]+):\s*(0x[0-9a-fA-F]+|\d+)/i);
      if (match) {
        registers.push({
          name: match[1],
          value: match[2],
          description: this.getRegisterDescription(match[1])
        });
      }
    }

    return registers;
  }

  /**
   * Get description for common registers
   */
  private getRegisterDescription(registerName: string): string {
    const descriptions: { [key: string]: string } = {
      'R0': 'General Purpose Register 0',
      'R1': 'General Purpose Register 1',
      'R2': 'General Purpose Register 2',
      'R3': 'General Purpose Register 3',
      'R4': 'General Purpose Register 4',
      'R5': 'General Purpose Register 5',
      'R6': 'General Purpose Register 6',
      'R7': 'General Purpose Register 7',
      'R8': 'General Purpose Register 8',
      'R9': 'General Purpose Register 9',
      'R10': 'General Purpose Register 10',
      'R11': 'General Purpose Register 11',
      'R12': 'General Purpose Register 12',
      'SP': 'Stack Pointer (R13)',
      'R13': 'Stack Pointer',
      'LR': 'Link Register (R14)',
      'R14': 'Link Register',
      'PC': 'Program Counter (R15)',
      'R15': 'Program Counter',
      'XPSR': 'Program Status Register',
      'PSR': 'Program Status Register'
    };

    return descriptions[registerName.toUpperCase()] || '';
  }

  /**
   * Refresh the webview with current data
   */
  public refresh() {
    if (!this._view) {
      return;
    }

    this._view.webview.postMessage({
      type: "update",
      registryData: this.registryData,
    });
  }

  /**
   * Execute swd-debugger command
   */
  private async executeSwdCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      this.outputChannel.appendLine(`Executing: ${this.swdDebuggerPath} ${args.join(' ')}`);

      const process = spawn(this.swdDebuggerPath, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        this.outputChannel.append(output);
      });

      process.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        this.outputChannel.append(output);
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
        }
      });

      process.on('error', (error) => {
        reject(new Error(`Process error: ${error.message}`));
      });

      // Set timeout for commands
      setTimeout(() => {
        process.kill();
        reject(new Error('Command timed out'));
      }, 10000);
    });
  }

  /**
   * Generate HTML for the webview
   */
  private _getHtmlForWebview() {
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
            <title>Data</title>
            <style>
                body {
                    padding: 0;
                    margin: 0;
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    overflow: hidden;
                }

                .container {
                    padding: 10px;
                    overflow-y: auto;
                    height: 100vh;
                }

                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px;
                    background-color: var(--vscode-titleBar-activeBackground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    position: sticky;
                    top: 0;
                    z-index: 10;
                }

                .refresh-btn {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 4px 8px;
                    cursor: pointer;
                    border-radius: 2px;
                    font-size: 11px;
                }

                .refresh-btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }

                /* Section headers */
                .section-header {
                    padding: 8px 10px;
                    background-color: var(--vscode-sideBar-background);
                    border-bottom: 2px solid var(--vscode-panel-border);
                    font-weight: 600;
                    font-size: 12px;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    margin-top: 10px;
                }

                .section-header:first-child {
                    margin-top: 0;
                }

                .section-icon {
                    font-size: 14px;
                }

                .section-count {
                    margin-left: auto;
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    padding: 2px 6px;
                    border-radius: 10px;
                    font-size: 10px;
                }

                /* Register item */
                .register-item {
                    padding: 8px 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    transition: background-color 0.2s ease;
                }

                .register-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }

                .register-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 4px;
                }

                .register-name {
                    font-weight: 500;
                    font-size: 13px;
                    color: var(--vscode-symbolIcon-variableForeground);
                    min-width: 60px;
                }

                .register-value {
                    font-family: 'Courier New', Consolas, monospace;
                    font-size: 11px;
                    color: var(--vscode-debugTokenExpression-numberForeground);
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 2px 6px;
                    border-radius: 3px;
                }

                .register-description {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    margin-left: 68px;
                    font-style: italic;
                }

                .empty-state {
                    text-align: center;
                    padding: 40px 20px;
                    color: var(--vscode-descriptionForeground);
                }

                .empty-icon {
                    font-size: 48px;
                    margin-bottom: 12px;
                    opacity: 0.5;
                }

                .empty-title {
                    font-size: 14px;
                    font-weight: 500;
                    margin-bottom: 6px;
                }

                .empty-description {
                    font-size: 11px;
                    opacity: 0.8;
                }

                /* Scrollbar styling */
                .container::-webkit-scrollbar {
                    width: 10px;
                }

                .container::-webkit-scrollbar-track {
                    background: var(--vscode-scrollbarSlider-background);
                }

                .container::-webkit-scrollbar-thumb {
                    background: var(--vscode-scrollbarSlider-hoverBackground);
                    border-radius: 5px;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <button class="refresh-btn" onclick="refreshData()">🔄 Refresh</button>
            </div>
            <div class="container" id="data-container">
                <div class="empty-state">
                    <div class="empty-icon">📊</div>
                    <div class="empty-title">No Data Available</div>
                    <div class="empty-description">Start debugging and halt to see registry data</div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.type === 'update') {
                        renderData(message.registryData);
                    }
                });

                function renderData(registryData) {
                    const container = document.getElementById('data-container');

                    if (!registryData || registryData.length === 0) {
                        container.innerHTML = \`
                            <div class="empty-state">
                                <div class="empty-icon">📊</div>
                                <div class="empty-title">No Data Available</div>
                                <div class="empty-description">Start debugging and halt to see registry data</div>
                            </div>
                        \`;
                        return;
                    }

                    let html = '';

                    // Registry Section
                    html += \`
                        <div class="section-header">
                            <span class="section-icon">📋</span>
                            <span>Registry</span>
                            <span class="section-count">\${registryData.length}</span>
                        </div>
                    \`;

                    registryData.forEach(register => {
                        html += \`
                            <div class="register-item">
                                <div class="register-header">
                                    <span class="register-name">\${register.name}</span>
                                    <span class="register-value">\${register.value}</span>
                                </div>
                                \${register.description ? \`<div class="register-description">\${register.description}</div>\` : ''}
                            </div>
                        \`;
                    });

                    container.innerHTML = html;
                }

                function refreshData() {
                    vscode.postMessage({ type: 'refresh' });
                }
            </script>
        </body>
        </html>`;
  }
}
