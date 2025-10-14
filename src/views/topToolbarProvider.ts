import * as vscode from "vscode";

/**
 * TopToolbarProvider manages the top toolbar webview in the sidebar
 * This displays debug control buttons above breakpoints/variables
 * Only visible when debug session is active
 */
export class TopToolbarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _isDebugActive: boolean = false;
  private readonly _extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this._extensionUri = extensionUri;
  }

  /**
   * Called when the view becomes visible
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    // Configure webview options
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    // Set the initial HTML content
    this._updateContent();

    // Handle button clicks from the webview
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "halt":
          vscode.commands.executeCommand("extension.haltCommand");
          break;
        case "resume":
          vscode.commands.executeCommand("extension.resumeCommand");
          break;
        case "flash":
          vscode.commands.executeCommand("extension.flashCommand");
          break;
        case "connect":
          vscode.commands.executeCommand("extension.connectCommand");
          break;
        case "stop":
          vscode.commands.executeCommand("port11-debugger.debug.stop");
          break;
        case "step":
          vscode.commands.executeCommand("port11-debugger.debug.stepOver");
          break;
      }
    });
  }

  /**
   * Show the toolbar when debug session starts
   */
  public show() {
    this._isDebugActive = true;
    // Show the entire view section
    vscode.commands.executeCommand('setContext', 'port11.debugActive', true);
    this._updateContent();
  }

  /**
   * Hide the toolbar when debug session stops
   */
  public hide() {
    this._isDebugActive = false;
    // Hide the entire view section
    vscode.commands.executeCommand('setContext', 'port11.debugActive', false);
    this._updateContent();
  }

  /**
   * Update the webview content based on debug state
   */
  private _updateContent() {
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview();
    }
  }

  /**
   * Check if toolbar is currently visible
   */
  public isVisible(): boolean {
    return this._isDebugActive;
  }

  /**
   * Dispose the toolbar
   */
  public dispose() {
    this._view = undefined;
  }

  /**
   * Generate HTML content for the toolbar webview
   */
  private _getHtmlForWebview() {
    // If debug is not active, show empty view
    if (!this._isDebugActive) {
      return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    display: none;
                }
            </style>
        </head>
        <body></body>
        </html>`;
    }

    // Show toolbar when debug is active
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
            <title>Debug Toolbar</title>
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    overflow: hidden;
                    background-color: var(--vscode-sideBar-background);
                    font-family: var(--vscode-font-family);
                }

                .toolbar {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                    padding: 8px 4px;
                    background-color: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                }

                .toolbar-button {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 32px;
                    height: 32px;
                    border: none;
                    background: transparent;
                    cursor: pointer;
                    border-radius: 5px;
                    transition: all 0.15s ease;
                    padding: 0;
                }

                .toolbar-button:hover {
                    background-color: var(--vscode-list-hoverBackground);
                    transform: scale(1.1);
                }

                .toolbar-button:active {
                    background-color: #cccccc;
                    transform: scale(0.95);
                }

                /* SVG icons with specific colors */
                .icon {
                    width: 24px;
                    height: 24px;
                }

                /* Button-specific colors */
                .icon-resume { color: #cccccc; } /* Light Blue */
                .icon-stop { color: #cccccc; } /* Red */
                .icon-step { color: #cccccc; } /* Blue */
                .icon-halt { color: #cccccc; } /* Purple */
                .icon-flash { color: #cccccc; } /* Yellow */
                .icon-connect { color: #cccccc; } /* Green */

                .separator {
                    width: 1px;
                    height: 24px;
                    background-color: var(--vscode-panel-border);
                    margin: 0 2px;
                }
            </style>
        </head>
        <body>
            <div class="toolbar">
                <!-- Resume Button -->
                <button class="toolbar-button" onclick="sendCommand('resume')" title="Resume Target">
                    <svg class="icon icon-resume" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M4 3v10l9-5z"/>
                    </svg>
                </button>

                <!-- Stop Button -->
                <button class="toolbar-button" onclick="sendCommand('stop')" title="Stop Debug Session">
                    <svg class="icon icon-stop" viewBox="0 0 16 16" fill="currentColor">
                        <rect x="4" y="4" width="8" height="8" rx="1"/>
                    </svg>
                </button>

                <!-- Step Button -->
                <button class="toolbar-button" onclick="sendCommand('step')" title="Step Over">
                    <svg class="icon icon-step" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 1l5 5-5 5V8H3V4h5V1zm1 9v3l3-3h-3z"/>
                    </svg>
                </button>

                <div class="separator"></div>

                <!-- Halt Button -->
                <button class="toolbar-button" onclick="sendCommand('halt')" title="Halt Target">
                    <svg class="icon icon-halt" viewBox="0 0 16 16" fill="currentColor">
                        <rect x="4" y="3" width="3" height="10" rx="0.5"/>
                        <rect x="9" y="3" width="3" height="10" rx="0.5"/>
                    </svg>
                </button>

                <div class="separator"></div>

                <!-- Flash Button -->
                <button class="toolbar-button" onclick="sendCommand('flash')" title="Flash Firmware">
                    <svg class="icon icon-flash" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M10 1L6 9h3l-1 6 5-8H9l1-6z"/>
                    </svg>
                </button>

                <!-- Connect Button -->
                <button class="toolbar-button" onclick="sendCommand('connect')" title="Connect to Port">
                    <svg class="icon icon-connect" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M11 4h1v1h-1V4zm-1 2V5h1v1h-1zm-1 1h1V6h-1v1zm-1 1V7h1v1H8zm5-4h-1V3h1v1zm1 1V4h-1v1h1zm1 1h-1V5h1v1zm0 1V6h1v1h-1zm-2 2h1V7h-1v1zM2 6h5v1H2V6zm0 2h4v1H2V8zm13 2h-3v1h3v-1zm0 2h-3v1h3v-1zM2 10h3v1H2v-1zm0 2h3v1H2v-1z"/>
                    </svg>
                </button>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                function sendCommand(command) {
                    vscode.postMessage({ command: command });
                }
            </script>
        </body>
        </html>`;
  }
}
