import * as vscode from "vscode";
import { VariableInfo, VariablesData } from "../types/variable";
import { AddressMapper } from "../utils/addressMapper";

/**
 * VariablesViewProvider manages the variables webview panel
 * Displays variable names, addresses, and line numbers in VS Code style
 * Also shows breakpoint addresses when breakpoints are set
 */
export class VariablesViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private outputChannel: vscode.OutputChannel;
  private variablesData: VariablesData = {
    localVariables: [],
    globalVariables: [],
    totalCount: 0,
    isValid: false,
  };
  private isDebugActive: boolean = false;
  private addressMapper: AddressMapper;

  constructor(
    private readonly extensionUri: vscode.Uri,
    outputChannel: vscode.OutputChannel
  ) {
    this.outputChannel = outputChannel;
    this.addressMapper = new AddressMapper();

    // Listen for breakpoint changes and refresh
    vscode.debug.onDidChangeBreakpoints(() => {
      this.refresh();
    });
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
        this.refresh();
      } else if (message.type === "navigateToVariable") {
        this.navigateToVariable(message.variable);
      }
    });

    // Initial render
    this.refresh();
  }

  /**
   * Update the variables display
   */
  public updateVariables(data: VariablesData, isActive: boolean) {
    this.variablesData = data;
    this.isDebugActive = isActive;
    this.refresh();
  }

  /**
   * Load disassembly for address mapping
   */
  public async loadDisassembly(workspaceRoot: string): Promise<void> {
    const loaded = await this.addressMapper.loadDisassembly(workspaceRoot);
    if (loaded) {
      this.outputChannel.appendLine('SUCCESS: Address mapper loaded successfully');
      this.refresh();
    } else {
      } catch (error) {
      this.outputChannel.appendLine('WARNING: Could not load disassembly for address mapping');
    }
  }

  /**
   * Refresh the webview with current data
   */
  public refresh() {
    if (!this._view) {
      return;
    }

    // Get breakpoint addresses
    const breakpointAddresses = this.addressMapper.getBreakpointAddresses();

    this._view.webview.postMessage({
      type: "update",
      data: this.variablesData,
      isDebugActive: this.isDebugActive,
      breakpointAddresses: breakpointAddresses,
    });
  }

  /**
   * Navigate to source location of a variable
   */
  private async navigateToVariable(variable: VariableInfo) {
    if (!variable.filePath || !variable.line) {
      vscode.window.showInformationMessage(
        `No source location available for variable: ${variable.name}`
      );
      return;
    }

    try {
      // Try to resolve the file path
      const uri = this.resolveFilePath(variable.filePath);
      if (!uri) {
        vscode.window.showWarningMessage(
          `Could not find file: ${variable.filePath}`
        );
        return;
      }

      // Open the document and navigate to the line
      const document = await vscode.workspace.openTextDocument(uri);
      const line = variable.line - 1; // Convert to 0-based

      await vscode.window.showTextDocument(document, {
        selection: new vscode.Range(
          new vscode.Position(line, 0),
          new vscode.Position(line, 0)
        ),
      });

      this.outputChannel.appendLine(
        `Navigated to: ${variable.name} at ${variable.filePath}:${variable.line}`
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open file: ${variable.filePath} - ${error}`
      );
    }
  }

  /**
   * Resolve file path to URI
   */
  private resolveFilePath(filePath: string): vscode.Uri | null {
    // If it's already an absolute path
    if (filePath.startsWith("/") || filePath.match(/^[a-zA-Z]:\\/)) {
      return vscode.Uri.file(filePath);
    }

    // Try to find in workspace
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
      return fullPath;
    }

    return null;
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
            <title>Variables</title>
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

                /* Variable item */
                .variable-item {
                    padding: 8px 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    cursor: pointer;
                    transition: background-color 0.2s ease, transform 0.1s ease;
                    position: relative;
                }

                .variable-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                    transform: translateX(2px);
                }

                .variable-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 4px;
                }

                .variable-name {
                    font-weight: 500;
                    font-size: 13px;
                    flex: 1;
                    color: var(--vscode-symbolIcon-variableForeground);
                }

                .variable-address {
                    font-family: 'Courier New', Consolas, monospace;
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 2px 6px;
                    border-radius: 3px;
                }

                .variable-details {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    margin-left: 0px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .variable-location {
                    color: var(--vscode-textLink-foreground);
                }

                .variable-type {
                    font-style: italic;
                    opacity: 0.8;
                }

                .variable-value {
                    font-family: 'Courier New', Consolas, monospace;
                    color: var(--vscode-debugTokenExpression-numberForeground);
                }

                /* Scope indicators */
                .scope-badge {
                    display: inline-block;
                    padding: 2px 6px;
                    border-radius: 3px;
                    font-size: 9px;
                    font-weight: bold;
                    text-transform: uppercase;
                }

                .scope-local {
                    background-color: rgba(76, 175, 80, 0.2);
                    color: #4CAF50;
                }

                .scope-global {
                    background-color: rgba(33, 150, 243, 0.2);
                    color: #2196F3;
                }

                .scope-static {
                    background-color: rgba(156, 39, 176, 0.2);
                    color: #9C27B0;
                }

                .scope-argument {
                    background-color: rgba(255, 152, 0, 0.2);
                    color: #FF9800;
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

                .empty-section {
                    text-align: center;
                    padding: 20px;
                    color: var(--vscode-descriptionForeground);
                    font-size: 11px;
                    font-style: italic;
                    opacity: 0.7;
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
                <button class="refresh-btn" onclick="refreshVariables()">Refresh</button>
            </div>
            <div class="container" id="variables-container">
                <div class="empty-state">
                    <div class="empty-icon">[VARS]</div>
                    <div class="empty-title">No Debug Session</div>
                    <div class="empty-description">Start debugging to see variables</div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.type === 'update') {
                        renderVariables(message.data, message.isDebugActive, message.breakpointAddresses);
                    }
                });

                function renderVariables(data, isDebugActive, breakpointAddresses) {
                    const container = document.getElementById('variables-container');

                    let html = '';

                    // Breakpoint Addresses Section (always show if there are breakpoints)
                    if (breakpointAddresses && breakpointAddresses.length > 0) {

                        breakpointAddresses.forEach(bp => {
                            const label = bp.functionName ? bp.functionName : \`\${bp.file}:\${bp.line}\`;
                            html += \`
                                <div class="variable-item">
                                    <div class="variable-header">
                                        <span class="variable-name">\${label}</span>
                                        <span class="variable-address">\${bp.address}</span>
                                    </div>
                                </div>
                            \`;
                        });
                    }

                    if (!isDebugActive || !data || !data.isValid) {
                        if (breakpointAddresses && breakpointAddresses.length > 0) {
                            // If we have breakpoints but no debug session, show just breakpoints
                            container.innerHTML = html + \`
                                <div class="empty-state">
                                    <div class="empty-icon">📋</div>
                                    <div class="empty-title">No Debug Session</div>
                                    <div class="empty-description">Start debugging to see variables</div>
                                </div>
                            \`;
                        } else {
                            container.innerHTML = \`
                                <div class="empty-state">
                                    <div class="empty-icon">📋</div>
                                    <div class="empty-title">No Debug Session</div>
                                    <div class="empty-description">Start debugging to see variables</div>
                                </div>
                            \`;
                        }
                        return;
                    }


                    container.innerHTML = html;
                }

                function renderVariableItem(variable) {
                    const scopeClass = 'scope-' + variable.scope;
                    const scopeLabel = variable.scope.charAt(0).toUpperCase() + variable.scope.slice(1);

                    // Build location string
                    let location = '';
                    if (variable.filePath && variable.line) {
                        const fileName = variable.filePath.split('/').pop() || variable.filePath;
                        location = \`<span class="variable-location">\${fileName}:\${variable.line}</span>\`;
                    }

                    // Build type string
                    let typeStr = '';
                    if (variable.type) {
                        typeStr = \`<span class="variable-type">\${variable.type}</span>\`;
                    }

                    // Build value string
                    let valueStr = '';
                    if (variable.value) {
                        valueStr = \`<span class="variable-value">= \${variable.value}</span>\`;
                    }

                    // Build tooltip
                    const tooltip = [
                        \`Name: \${variable.name}\`,
                        \`Address: \${variable.address}\`,
                        variable.type ? \`Type: \${variable.type}\` : '',
                        variable.value ? \`Value: \${variable.value}\` : '',
                        variable.filePath ? \`Location: \${variable.filePath}:\${variable.line || ''}\` : ''
                    ].filter(Boolean).join('\\n');

                    return \`
                        <div class="variable-item"
                             onclick='navigateToVariable(\${JSON.stringify(variable)})'
                             title="\${tooltip}">
                            <div class="variable-header">
                                <span class="scope-badge \${scopeClass}">\${scopeLabel}</span>
                                <span class="variable-name">\${variable.name}</span>
                                <span class="variable-address">\${variable.address}</span>
                            </div>
                            \${(location || typeStr || valueStr) ? \`
                                <div class="variable-details">
                                    \${location}
                                    \${typeStr}
                                    \${valueStr}
                                </div>
                            \` : ''}
                        </div>
                    \`;
                }

                function navigateToVariable(variable) {
                    vscode.postMessage({ type: 'navigateToVariable', variable: variable });
                }

                function refreshVariables() {
                    vscode.postMessage({ type: 'refresh' });
                }
            </script>
        </body>
        </html>`;
  }
}
