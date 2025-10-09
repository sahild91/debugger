import * as vscode from "vscode";
import { ConnectionManager, BoardInfo } from "../managers/connectionManager";

/**
 * BoardsViewProvider manages the boards webview panel
 * Displays connected boards with smooth animations
 */
export class BoardsViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private connectionManager: ConnectionManager;
  private outputChannel: vscode.OutputChannel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    connectionManager: ConnectionManager,
    outputChannel: vscode.OutputChannel
  ) {
    this.connectionManager = connectionManager;
    this.outputChannel = outputChannel;
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
      if (message.type === "detectBoards") {
        this.detectBoards();
      } else if (message.type === "selectBoard") {
        this.selectBoard(message.path);
      }
    });

    // Initial load
    this.refresh();
  }

  public async refresh() {
    if (!this._view) {
      return;
    }

    try {
      const boards = await this.connectionManager.detectBoards();
      const selectedPort = this.connectionManager.getSelectedPort();

      const boardsData = boards.map((board: BoardInfo) => ({
        friendlyName: board.friendlyName || board.path,
        path: board.path,
        isConnected: board.isConnected || board.path === selectedPort,
        manufacturer: board.manufacturer,
        vendorId: board.vendorId,
        productId: board.productId,
        serialNumber: board.serialNumber,
        deviceType: board.deviceType,
      }));

      this._view.webview.postMessage({
        type: "update",
        boards: boardsData,
      });
    } catch (error) {
      this.outputChannel.appendLine(`Error refreshing boards: ${error}`);
    }
  }

  private async detectBoards() {
    try {
      this.outputChannel.appendLine("Detecting boards...");
      await this.refresh();
      vscode.window.showInformationMessage("Board detection complete");
    } catch (error) {
      vscode.window.showErrorMessage(`Board detection failed: ${error}`);
    }
  }

  private async selectBoard(path: string) {
    // This would trigger the connection logic
    vscode.commands.executeCommand("extension.connectCommand");
  }

  private _getHtmlForWebview() {
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
            <title>Boards</title>
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
                    right: 0;
                    z-index: 10;
                }

                .detect-btn {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 4px 8px;
                    cursor: pointer;
                    border-radius: 2px;
                    font-size: 11px;
                }

                .detect-btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }

                .board-item {
                    padding: 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    cursor: pointer;
                    transition: background-color 0.2s ease, transform 0.1s ease;
                }

                .board-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                    transform: translateX(2px);
                }

                .board-header {
                    display: flex;
                    align-items: center;
                    margin-bottom: 4px;
                }

                .board-icon {
                    margin-right: 8px;
                    font-size: 16px;
                }

                .board-name {
                    font-weight: 500;
                    font-size: 13px;
                    flex: 1;
                }

                .board-status {
                    font-size: 10px;
                    padding: 2px 6px;
                    border-radius: 3px;
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                }

                .board-status.connected {
                    background-color: #28a745;
                    color: white;
                }

                .board-details {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    margin-left: 24px;
                    line-height: 1.4;
                }

                .empty-state {
                    text-align: center;
                    padding: 30px 20px;
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                }

                .scan-icon {
                    font-size: 40px;
                    margin-bottom: 10px;
                    opacity: 0.5;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <button class="detect-btn" onclick="detectBoards()">🔍 Detect</button>
            </div>
            <div class="container" id="boards-container">
                <div class="empty-state">
                    <div class="scan-icon">📡</div>
                    <div>No boards detected</div>
                    <div style="font-size: 10px; margin-top: 8px;">Click Detect to scan</div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.type === 'update') {
                        renderBoards(message.boards);
                    }
                });

                function renderBoards(boards) {
                    const container = document.getElementById('boards-container');

                    if (boards.length === 0) {
                        container.innerHTML = \`
                            <div class="empty-state">
                                <div class="scan-icon">📡</div>
                                <div>No boards detected</div>
                                <div style="font-size: 10px; margin-top: 8px;">Click Detect to scan</div>
                            </div>
                        \`;
                        return;
                    }

                    let html = '';
                    boards.forEach(board => {
                        const icon = board.isConnected ? '🟢' : '⚪';
                        const statusClass = board.isConnected ? 'connected' : '';
                        const statusText = board.isConnected ? 'Connected' : 'Available';

                        html += \`
                            <div class="board-item" onclick="selectBoard('\${board.path}')">
                                <div class="board-header">
                                    <span class="board-icon">\${icon}</span>
                                    <span class="board-name">\${board.friendlyName}</span>
                                    <span class="board-status \${statusClass}">\${statusText}</span>
                                </div>
                                <div class="board-details">
                                    <div>Port: \${board.path}</div>
                                    \${board.manufacturer ? \`<div>Manufacturer: \${board.manufacturer}</div>\` : ''}
                                    \${board.deviceType && board.deviceType !== 'Unknown' ? \`<div>Type: \${board.deviceType}</div>\` : ''}
                                </div>
                            </div>
                        \`;
                    });

                    container.innerHTML = html;
                }

                function detectBoards() {
                    vscode.postMessage({ type: 'detectBoards' });
                }

                function selectBoard(path) {
                    vscode.postMessage({ type: 'selectBoard', path: path });
                }
            </script>
        </body>
        </html>`;
  }
}
