import * as vscode from "vscode";
import { SDKManager } from "../managers/sdkManager";
import { ToolchainManager } from "../managers/toolchainManager";
import { SysConfigManager } from "../managers/sysconfigManager";

/**
 * SetupViewProvider manages the setup status webview panel
 * Displays installation status of SDK, Toolchain, and SysConfig
 */
export class SetupViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private sdkManager: SDKManager;
  private toolchainManager: ToolchainManager;
  private sysConfigManager: SysConfigManager;
  private outputChannel: vscode.OutputChannel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    managers: {
      sdkManager: SDKManager;
      toolchainManager: ToolchainManager;
      sysConfigManager: SysConfigManager;
    },
    outputChannel: vscode.OutputChannel
  ) {
    this.sdkManager = managers.sdkManager;
    this.toolchainManager = managers.toolchainManager;
    this.sysConfigManager = managers.sysConfigManager;
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
      if (message.type === "runSetup") {
        this.runSetup();
      } else if (message.type === "refresh") {
        this.refresh();
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
      const sdkInstalled = await this.sdkManager.isSDKInstalled();
      const sdkVersion = sdkInstalled ? await this.sdkManager.getSDKVersion() : null;

      const toolchainInstalled = await this.toolchainManager.isToolchainInstalled();
      const toolchainInfo = toolchainInstalled
        ? await this.toolchainManager.getToolchainInfo()
        : null;

      const sysConfigInstalled = await this.sysConfigManager.isSysConfigInstalled();
      const sysConfigInfo = sysConfigInstalled
        ? await this.sysConfigManager.getSysConfigInfo()
        : null;

      const setupData = {
        sdk: {
          installed: sdkInstalled,
          version: sdkVersion,
        },
        toolchain: {
          installed: toolchainInstalled,
          version: toolchainInfo?.version || null,
        },
        sysconfig: {
          installed: sysConfigInstalled,
          version: sysConfigInfo?.version || null,
        },
        debugger: {
          installed: true, // Always installed if extension is running
          version: "Built-in",
        },
      };

      this._view.webview.postMessage({
        type: "update",
        setup: setupData,
      });
    } catch (error) {
      this.outputChannel.appendLine(`Error refreshing setup status: ${error}`);
    }
  }

  private async runSetup() {
    vscode.commands.executeCommand("port11-debugger.setupToolchain");
  }

  private _getHtmlForWebview() {
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
            <title>Setup Status</title>
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

                .setup-item {
                    padding: 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    transition: background-color 0.2s ease;
                }

                .setup-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }

                .setup-header {
                    display: flex;
                    align-items: center;
                    margin-bottom: 4px;
                }

                .setup-icon {
                    margin-right: 8px;
                    font-size: 16px;
                }

                .setup-name {
                    font-weight: 500;
                    font-size: 13px;
                    flex: 1;
                }

                .setup-status {
                    font-size: 10px;
                    padding: 2px 6px;
                    border-radius: 3px;
                }

                .setup-status.installed {
                    background-color: #28a745;
                    color: white;
                }

                .setup-status.not-installed {
                    background-color: #dc3545;
                    color: white;
                }

                .setup-version {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    margin-left: 24px;
                }

                .setup-action {
                    margin-top: 10px;
                    padding: 10px;
                    text-align: center;
                }

                .setup-btn {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 16px;
                    cursor: pointer;
                    border-radius: 3px;
                    font-size: 12px;
                    font-weight: 500;
                }

                .setup-btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }

                .all-installed {
                    text-align: center;
                    padding: 20px;
                    color: var(--vscode-descriptionForeground);
                }

                .checkmark {
                    font-size: 40px;
                    color: #28a745;
                    margin-bottom: 10px;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <button class="refresh-btn" onclick="refreshStatus()">Refresh</button>
            </div>
            <div class="container" id="setup-container">
                <div style="text-align: center; padding: 30px; color: var(--vscode-descriptionForeground);">
                    Loading...
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.type === 'update') {
                        renderSetupStatus(message.setup);
                    }
                });

                function renderSetupStatus(setup) {
                    const container = document.getElementById('setup-container');
                    const allInstalled = setup.sdk.installed && setup.toolchain.installed && setup.sysconfig.installed;

                    let html = '';

                    // SDK
                    html += renderSetupItem('MSPM0 SDK', setup.sdk.installed, setup.sdk.version, '[Package]');

                    // Toolchain
                    html += renderSetupItem('ARM-CGT-CLANG', setup.toolchain.installed, setup.toolchain.version, '[Setup]');

                    // SysConfig
                    html += renderSetupItem('TI SysConfig', setup.sysconfig.installed, setup.sysconfig.version, '[Config]');

                    // Debugger
                    html += renderSetupItem('SWD Debugger', setup.debugger.installed, setup.debugger.version, '[Debug]');

                    // Setup button or success message
                    if (allInstalled) {
                        html += \`
                            <div class="all-installed">
                                <div class="checkmark">[OK]</div>
                                <div style="font-weight: 500;">All components installed</div>
                                <div style="font-size: 11px; margin-top: 5px;">Ready for development</div>
                            </div>
                        \`;
                    } else {
                        html += \`
                            <div class="setup-action">
                                <button class="setup-btn" onclick="runSetup()">Run Complete Setup</button>
                            </div>
                        \`;
                    }

                    container.innerHTML = html;
                }

                function renderSetupItem(name, installed, version, icon) {
                    const statusClass = installed ? 'installed' : 'not-installed';
                    const statusText = installed ? 'Installed' : 'Not Installed';
                    const statusIcon = installed ? 'SUCCESS:' : 'ERROR:';

                    return \`
                        <div class="setup-item">
                            <div class="setup-header">
                                <span class="setup-icon">\${icon}</span>
                                <span class="setup-name">\${name}</span>
                                <span class="setup-status \${statusClass}">\${statusText}</span>
                            </div>
                            \${version ? \`<div class="setup-version">Version: \${version}</div>\` : ''}
                        </div>
                    \`;
                }

                function runSetup() {
                    vscode.postMessage({ type: 'runSetup' });
                }

                function refreshStatus() {
                    vscode.postMessage({ type: 'refresh' });
                }
            </script>
        </body>
        </html>`;
  }
}
