import * as vscode from "vscode";

/**
 * BreakpointsViewProvider manages the breakpoints webview panel
 * Displays all breakpoints with smooth animations and VS Code theming
 */
export class BreakpointsViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private outputChannel: vscode.OutputChannel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    outputChannel: vscode.OutputChannel
  ) {
    this.outputChannel = outputChannel;

    // Listen for breakpoint changes and refresh view
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
      if (message.type === "toggleBreakpoint") {
        this.toggleBreakpoint(message.index);
      } else if (message.type === "goToBreakpoint") {
        this.goToBreakpoint(message.index);
      } else if (message.type === "refresh") {
        this.refresh();
      }
    });

    // Initial load
    this.refresh();
  }

  public refresh() {
    if (!this._view) {
      return;
    }

    const breakpoints = this.getBreakpointsData();
    this._view.webview.postMessage({
      type: "update",
      breakpoints: breakpoints,
    });
  }

  private getBreakpointsData() {
    const allBreakpoints = vscode.debug.breakpoints;
    const breakpointsData: any[] = [];

    allBreakpoints.forEach((bp, index) => {
      if (bp instanceof vscode.SourceBreakpoint) {
        const location = bp.location;
        const fileName = vscode.workspace.asRelativePath(location.uri);
        const line = location.range.start.line + 1;

        breakpointsData.push({
          index: index,
          type: "source",
          label: `${fileName}:${line}`,
          enabled: bp.enabled,
          condition: bp.condition || null,
          uri: location.uri.toString(),
          line: location.range.start.line,
        });
      } else if (bp instanceof vscode.FunctionBreakpoint) {
        breakpointsData.push({
          index: index,
          type: "function",
          label: bp.functionName,
          enabled: bp.enabled,
          condition: bp.condition || null,
        });
      }
    });

    return breakpointsData;
  }

  private toggleBreakpoint(index: number) {
    const breakpoint = vscode.debug.breakpoints[index];
    if (!breakpoint) {
      return;
    }

    const shouldEnable = !breakpoint.enabled;

    if (breakpoint instanceof vscode.SourceBreakpoint) {
      const newBp = new vscode.SourceBreakpoint(
        breakpoint.location,
        shouldEnable,
        breakpoint.condition,
        breakpoint.hitCondition,
        breakpoint.logMessage
      );
      vscode.debug.removeBreakpoints([breakpoint]);
      vscode.debug.addBreakpoints([newBp]);
    } else if (breakpoint instanceof vscode.FunctionBreakpoint) {
      const newBp = new vscode.FunctionBreakpoint(
        breakpoint.functionName,
        shouldEnable,
        breakpoint.condition,
        breakpoint.hitCondition,
        breakpoint.logMessage
      );
      vscode.debug.removeBreakpoints([breakpoint]);
      vscode.debug.addBreakpoints([newBp]);
    }

    this.outputChannel.appendLine(
      `Breakpoint ${shouldEnable ? "enabled" : "disabled"}`
    );
  }

  private goToBreakpoint(index: number) {
    const breakpoint = vscode.debug.breakpoints[index];
    if (breakpoint instanceof vscode.SourceBreakpoint) {
      const location = breakpoint.location;
      vscode.window.showTextDocument(location.uri, {
        selection: new vscode.Range(
          location.range.start,
          location.range.end
        ),
      });
    }
  }

  private _getHtmlForWebview() {
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
            <title>Breakpoints</title>
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

                .breakpoint-item {
                    display: flex;
                    align-items: center;
                    padding: 8px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    cursor: pointer;
                    transition: background-color 0.2s ease;
                }

                .breakpoint-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }

                .breakpoint-checkbox {
                    width: 16px;
                    height: 16px;
                    margin-right: 10px;
                    cursor: pointer;
                    accent-color: var(--vscode-checkbox-background);
                }

                .breakpoint-icon {
                    margin-right: 8px;
                    font-size: 14px;
                }

                .breakpoint-label {
                    flex: 1;
                    font-family: var(--vscode-editor-font-family);
                    font-size: 12px;
                }

                .breakpoint-condition {
                    font-size: 10px;
                    color: var(--vscode-descriptionForeground);
                    margin-left: 34px;
                    padding: 2px 0;
                }

                .empty-state {
                    text-align: center;
                    padding: 30px 20px;
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                }

                .disabled {
                    opacity: 0.5;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <button class="refresh-btn" onclick="refreshBreakpoints()">Refresh</button>
            </div>
            <div class="container" id="breakpoints-container">
                <div class="empty-state">No breakpoints set</div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.type === 'update') {
                        renderBreakpoints(message.breakpoints);
                    }
                });

                function renderBreakpoints(breakpoints) {
                    const container = document.getElementById('breakpoints-container');

                    if (breakpoints.length === 0) {
                        container.innerHTML = '<div class="empty-state">No breakpoints set</div>';
                        return;
                    }

                    let html = '';
                    breakpoints.forEach(bp => {
                        if (breakpoints.length > 0) {
                        const icon = bp.type === 'function' ? '[F]' : '[L]';
                        const disabledClass = bp.enabled ? '' : 'disabled';

                        html += \`
                            <div class="breakpoint-item \${disabledClass}">
                                <input type="checkbox"
                                       class="breakpoint-checkbox"
                                       \${bp.enabled ? 'checked' : ''}
                                       onchange="toggleBreakpoint(\${bp.index})">
                                <span class="breakpoint-icon">\${icon}</span>
                                <span class="breakpoint-label" onclick="goToBreakpoint(\${bp.index})">\${bp.label}</span>
                            </div>
                            \${bp.condition ? \`<div class="breakpoint-condition">Condition: \${bp.condition}</div>\` : ''}
                        \`;
                    });

                    container.innerHTML = html;
                }

                function toggleBreakpoint(index) {
                    vscode.postMessage({ type: 'toggleBreakpoint', index: index });
                }

                function goToBreakpoint(index) {
                    vscode.postMessage({ type: 'goToBreakpoint', index: index });
                }

                function refreshBreakpoints() {
                    vscode.postMessage({ type: 'refresh' });
                }
            </script>
        </body>
        </html>`;
  }
}
