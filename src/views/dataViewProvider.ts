import * as vscode from "vscode";
import { spawn } from "child_process";
import { VariableInfo, RegisterData, DataViewContent } from "../types/variable";

/**
 * DataViewProvider manages the unified data webview panel
 * Displays both CPU registers and program variables
 * Registry section shows PC at the top, followed by other registers
 * Variables are grouped into Local and Global sections
 */
export class DataViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private outputChannel: vscode.OutputChannel;
  private swdDebuggerPath: string;
  private dataContent: DataViewContent = {
    registers: [],
    localVariables: [],
    globalVariables: [],
    isDebugActive: false,
  };

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
        this.updateAll();
      }
    });

    // Initial render
    this.refresh();
  }

  /**
   * Update both registry and variables data
   * This is the main method called when Halt/Step is triggered
   */
  public async updateAll(): Promise<void> {
    try {
      this.outputChannel.appendLine('Updating Data View (Registry + Variables)...');
      
      // Update registry data
      await this.updateRegistryData();
      
      // Note: Variables are updated separately via updateVariables() 
      // which is called from extension.ts after getVariables()
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`Failed to update data view: ${errorMsg}`);
    }
  }

  /**
   * Update only registry data by executing swd-debugger read-all
   */
  public async updateRegistryData(): Promise<void> {
    try {
      this.outputChannel.appendLine('Reading registry data...');
      const output = await this.executeSwdCommand(['read-all']);
      
      // Parse the output
      const registers = this.parseRegistryOutput(output);
      
      // Sort registers with PC at the top
      this.dataContent.registers = this.sortRegisters(registers);

      this.outputChannel.appendLine(`Registry data updated: ${this.dataContent.registers.length} registers`);
      this.refresh();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`Failed to read registry data: ${errorMsg}`);
      this.dataContent.registers = [];
      this.refresh();
    }
  }

  /**
   * Update variables data (called from extension.ts with data from debugCommand.getVariables())
   */
  public updateVariables(localVars: VariableInfo[], globalVars: VariableInfo[], isActive: boolean): void {
    this.outputChannel.appendLine(`Updating variables: ${localVars.length} local, ${globalVars.length} global`);
    
    this.dataContent.localVariables = localVars;
    this.dataContent.globalVariables = globalVars;
    this.dataContent.isDebugActive = isActive;
    
    this.refresh();
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
   * Sort registers with PC at the top, followed by SP, LR, then R0-R15, then others
   */
  private sortRegisters(registers: RegisterData[]): RegisterData[] {
    const priority: { [key: string]: number } = {
      'PC': 1,
      'R15': 1,
      'SP': 2,
      'R13': 2,
      'LR': 3,
      'R14': 3,
    };

    return registers.sort((a, b) => {
      const aPriority = priority[a.name.toUpperCase()] || 100;
      const bPriority = priority[b.name.toUpperCase()] || 100;

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      // For registers with same priority, sort by name
      // Extract number from register name (e.g., R0 -> 0)
      const aNum = parseInt(a.name.replace(/[^0-9]/g, '')) || 999;
      const bNum = parseInt(b.name.replace(/[^0-9]/g, '')) || 999;
      
      if (aNum !== bNum) {
        return aNum - bNum;
      }

      return a.name.localeCompare(b.name);
    });
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

    this.outputChannel.appendLine(`Refreshing Data View webview...`);
    
    this._view.webview.postMessage({
      type: "update",
      data: this.dataContent,
    });
  }

  /**
   * Execute swd-debugger command
   */
  private async executeSwdCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      this.outputChannel.appendLine(
        `Executing: ${this.swdDebuggerPath} ${args.join(" ")}`
      );

      const process = spawn(this.swdDebuggerPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      process.stdout.on("data", (data) => {
        const output = data.toString();
        stdout += output;
      });

      process.stderr.on("data", (data) => {
        const output = data.toString();
        stderr += output;
      });

      process.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
        }
      });

      process.on("error", (error) => {
        reject(new Error(`Process error: ${error.message}`));
      });

      // Set timeout for commands
      setTimeout(() => {
        process.kill();
        reject(new Error("Command timed out"));
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
            <title>Data View</title>
            <style>
                body {
                    padding: 0;
                    margin: 0;
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                }

                .header {
                    padding: 8px 12px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    background-color: var(--vscode-sideBar-background);
                }

                .refresh-btn {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 4px 12px;
                    cursor: pointer;
                    border-radius: 2px;
                    font-size: 11px;
                }

                .refresh-btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }

                .container {
                    padding: 12px;
                    overflow-y: auto;
                    max-height: calc(100vh - 40px);
                }

                .section-header {
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                    padding: 8px 0 4px 0;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    margin-bottom: 8px;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }

                .section-icon {
                    font-size: 14px;
                }

                .section-count {
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 10px;
                    padding: 2px 6px;
                    font-size: 10px;
                    margin-left: auto;
                }

                .item {
                    padding: 6px 8px;
                    margin-bottom: 4px;
                    border-radius: 3px;
                    background-color: var(--vscode-list-hoverBackground);
                    transition: background-color 0.15s ease;
                }

                .item:hover {
                    background-color: var(--vscode-list-activeSelectionBackground);
                }

                .item-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 4px;
                }

                .item-name {
                    font-weight: 500;
                    font-size: 13px;
                    color: var(--vscode-symbolIcon-variableForeground);
                    min-width: 80px;
                }

                .item-name.pc {
                    color: var(--vscode-debugTokenExpression-nameForeground);
                    font-weight: 600;
                }

                .item-value {
                    font-family: 'Courier New', Consolas, monospace;
                    font-size: 11px;
                    color: var(--vscode-debugTokenExpression-numberForeground);
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 2px 6px;
                    border-radius: 3px;
                }

                .item-description {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    margin-left: 0px;
                    font-style: italic;
                }

                .item-details {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                    margin-top: 4px;
                    padding-left: 0px;
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                }

                .item-location {
                    font-size: 10px;
                    color: var(--vscode-descriptionForeground);
                }

                .item-type {
                    font-size: 10px;
                    color: var(--vscode-debugTokenExpression-stringForeground);
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

                .scope-badge {
                    font-size: 9px;
                    padding: 2px 6px;
                    border-radius: 3px;
                    font-weight: 600;
                    text-transform: uppercase;
                    margin-right: 6px;
                }

                .scope-local {
                    background-color: var(--vscode-debugTokenExpression-nameForeground);
                    color: var(--vscode-editor-background);
                }

                .scope-global {
                    background-color: var(--vscode-debugTokenExpression-stringForeground);
                    color: var(--vscode-editor-background);
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
                <button class="refresh-btn" onclick="refreshData()">Refresh</button>
            </div>
            <div class="container" id="data-container">
                <div class="empty-state">
                    <div class="empty-icon">[Data]</div>
                    <div class="empty-title">No Data Available</div>
                    <div class="empty-description">Start debugging and halt to see data</div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.type === 'update') {
                        renderData(message.data);
                    }
                });

                function renderData(data) {
                    const container = document.getElementById('data-container');

                    if (!data || (!data.registers.length && !data.localVariables.length && !data.globalVariables.length)) {
                        container.innerHTML = \`
                            <div class="empty-state">
                                <div class="empty-icon">[Data]</div>
                                <div class="empty-title">No Data Available</div>
                                <div class="empty-description">Start debugging and halt to see data</div>
                            </div>
                        \`;
                        return;
                    }

                    let html = '';

                    // Registry Section
                    if (data.registers && data.registers.length > 0) {
                        html += \`
                            <div class="section-header">
                                <span class="section-icon">[List]</span>
                                <span>Registry</span>
                                <span class="section-count">\${data.registers.length}</span>
                            </div>
                        \`;

                        data.registers.forEach(register => {
                            const isPc = register.name.toUpperCase() === 'PC' || register.name.toUpperCase() === 'R15';
                            html += \`
                                <div class="item">
                                    <div class="item-header">
                                        <span class="item-name \${isPc ? 'pc' : ''}">\${register.name}</span>
                                        <span class="item-value">\${register.value}</span>
                                    </div>
                                    \${register.description ? \`<div class="item-description">\${register.description}</div>\` : ''}
                                </div>
                            \`;
                        });
                    }

                    // Local Variables Section
                    if (data.localVariables && data.localVariables.length > 0) {
                        html += \`
                            <div class="section-header" style="margin-top: 16px;">
                                <span class="section-icon">[Setup]</span>
                                <span>Local Variables</span>
                                <span class="section-count">\${data.localVariables.length}</span>
                            </div>
                        \`;

                        data.localVariables.forEach(variable => {
                            html += renderVariable(variable, 'local');
                        });
                    }

                    // Global Variables Section
                    if (data.globalVariables && data.globalVariables.length > 0) {
                        html += \`
                            <div class="section-header" style="margin-top: 16px;">
                                <span class="section-icon">[Global]</span>
                                <span>Global Variables</span>
                                <span class="section-count">\${data.globalVariables.length}</span>
                            </div>
                        \`;

                        data.globalVariables.forEach(variable => {
                            html += renderVariable(variable, 'global');
                        });
                    }

                    container.innerHTML = html;
                }

                function renderVariable(variable, scope) {
                    let details = '';
                    
                    if (variable.filePath && variable.line) {
                        const fileName = variable.filePath.split('/').pop() || variable.filePath;
                        details += \`<span class="item-location">\${fileName}:\${variable.line}</span>\`;
                    }
                    
                    if (variable.type) {
                        details += \`<span class="item-type">\${variable.type}</span>\`;
                    }

                    return \`
                        <div class="item">
                            <div class="item-header">
                                <span>
                                    <span class="scope-badge scope-\${scope}">\${scope}</span>
                                    <span class="item-name">\${variable.name}</span>
                                </span>
                                <span class="item-value">\${variable.value || variable.address}</span>
                            </div>
                            \${details ? \`<div class="item-details">\${details}</div>\` : ''}
                        </div>
                    \`;
                }

                function refreshData() {
                    vscode.postMessage({ type: 'refresh' });
                }
            </script>
        </body>
        </html>`;
  }
}