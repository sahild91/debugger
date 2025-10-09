import * as vscode from "vscode";

/**
 * ConsoleViewProvider manages the console webview panel
 * This displays all console logs in a formatted, interactive view
 */
export class ConsoleViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private logs: string[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Called when the view becomes visible
   * This is where we set up the webview content and options
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    // Configure webview options
    webviewView.webview.options = {
      // Enable JavaScript in the webview
      enableScripts: true,
      // Restrict resources to extension directory
      localResourceRoots: [this.extensionUri],
    };

    // Set the initial HTML content
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview (like clear button clicks)
    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.type === "clear") {
        this.clearLogs();
      }
    });
  }

  /**
   * Add a new log message to the console
   * This will be called from extension.ts whenever outputChannel.appendLine is used
   */
  public addLog(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;

    // Store in memory
    this.logs.push(logEntry);

    // Keep only last 1000 logs to prevent memory issues
    if (this.logs.length > 1000) {
      this.logs.shift();
    }

    // Send to webview to display
    this._view?.webview.postMessage({
      type: "addLog",
      log: logEntry,
    });
  }

  /**
   * Clear all console logs
   */
  public clearLogs() {
    this.logs = [];
    this._view?.webview.postMessage({ type: "clear" });
  }

  /**
   * Generate HTML content for the webview
   * This creates the console UI with styling and interactive features
   */
  private _getHtmlForWebview(webview: vscode.Webview) {
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
            <title>Port11 Console</title>
            <style>
                /* Main body styling - uses VS Code theme colors */
                body {
                    padding: 0;
                    margin: 0;
                    font-family: 'Courier New', Consolas, monospace;
                    font-size: 12px;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    overflow: hidden;
                }

                /* Controls bar at the top */
                .controls {
                    padding: 8px;
                    background-color: var(--vscode-titleBar-activeBackground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    position: sticky;
                    top: 0;
                    display: flex;
                    gap: 8px;
                }

                /* Button styling */
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 12px;
                    cursor: pointer;
                    border-radius: 2px;
                    font-size: 12px;
                }

                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }

                button:active {
                    background-color: var(--vscode-button-activeBackground);
                }

                /* Console output area */
                #console {
                    padding: 10px;
                    white-space: pre-wrap;
                    word-wrap: break-word;
                    overflow-y: auto;
                    height: calc(100vh - 45px);
                    font-family: 'Courier New', Consolas, monospace;
                }

                /* Individual log entry */
                .log-entry {
                    padding: 3px 0;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    line-height: 1.4;
                }

                /* Alternate row colors for better readability */
                .log-entry:nth-child(even) {
                    background-color: var(--vscode-list-hoverBackground);
                }

                /* Scrollbar styling */
                #console::-webkit-scrollbar {
                    width: 10px;
                }

                #console::-webkit-scrollbar-track {
                    background: var(--vscode-scrollbarSlider-background);
                }

                #console::-webkit-scrollbar-thumb {
                    background: var(--vscode-scrollbarSlider-hoverBackground);
                    border-radius: 5px;
                }

                /* Empty state message */
                .empty-state {
                    color: var(--vscode-descriptionForeground);
                    text-align: center;
                    padding: 20px;
                    font-style: italic;
                }
            </style>
        </head>
        <body>
            <!-- Control buttons -->
            <div class="controls">
                <button onclick="clearConsole()" title="Clear all console logs">🗑️ Clear Console</button>
            </div>

            <!-- Console output area -->
            <div id="console">
                <div class="empty-state">Console is ready. Logs will appear here...</div>
            </div>

            <script>
                // Get VS Code API for communication with extension
                const vscode = acquireVsCodeApi();
                const consoleDiv = document.getElementById('console');
                let firstLog = true;

                // Listen for messages from the extension
                window.addEventListener('message', event => {
                    const message = event.data;

                    if (message.type === 'addLog') {
                        // Remove empty state on first log
                        if (firstLog) {
                            consoleDiv.innerHTML = '';
                            firstLog = false;
                        }

                        // Create and add new log entry
                        const logDiv = document.createElement('div');
                        logDiv.className = 'log-entry';
                        logDiv.textContent = message.log;
                        consoleDiv.appendChild(logDiv);

                        // Auto-scroll to bottom
                        consoleDiv.scrollTop = consoleDiv.scrollHeight;

                    } else if (message.type === 'clear') {
                        // Clear all logs
                        consoleDiv.innerHTML = '<div class="empty-state">Console cleared. Logs will appear here...</div>';
                        firstLog = true;
                    }
                });

                // Clear console function
                function clearConsole() {
                    vscode.postMessage({ type: 'clear' });
                }

                // Scroll to bottom function
                function scrollToBottom() {
                    consoleDiv.scrollTop = consoleDiv.scrollHeight;
                }
            </script>
        </body>
        </html>`;
  }
}
