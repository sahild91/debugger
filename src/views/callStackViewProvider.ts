import * as vscode from "vscode";
import { CallStackFrame } from "../types/callStack";

/**
 * CallStackViewProvider manages the call stack webview panel
 * Displays call stack frames in VS Code style with navigation support
 */
export class CallStackViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private outputChannel: vscode.OutputChannel;
  private callStack: CallStackFrame[] = [];
  private isDebugActive: boolean = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    outputChannel: vscode.OutputChannel
  ) {
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
      if (message.type === "navigateToFrame") {
        this.navigateToFrame(message.index);
      } else if (message.type === "refresh") {
        this.refresh();
      }
    });

    // Initial render
    this.refresh();
  }

  /**
   * Update the call stack display
   */
  public updateCallStack(frames: CallStackFrame[], isActive: boolean) {
    this.callStack = frames;
    this.isDebugActive = isActive;
    this.refresh();
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
      frames: this.callStack,
      isDebugActive: this.isDebugActive,
    });
  }

  /**
   * Navigate to source location of a stack frame
   */
  private async navigateToFrame(index: number) {
    const frame = this.callStack.find((f) => f.index === index);
    if (!frame) {
      return;
    }

    if (!frame.filePath) {
      vscode.window.showInformationMessage(
        `No source file available for ${frame.functionName}`
      );
      return;
    }

    try {
      // Try to resolve the file path
      const uri = this.resolveFilePath(frame.filePath);
      if (!uri) {
        vscode.window.showWarningMessage(
          `Could not find file: ${frame.filePath}`
        );
        return;
      }

      // Open the document and navigate to the line
      const document = await vscode.workspace.openTextDocument(uri);
      const line = frame.line ? frame.line - 1 : 0; // Convert to 0-based
      const column = frame.column ? frame.column - 1 : 0;

      await vscode.window.showTextDocument(document, {
        selection: new vscode.Range(
          new vscode.Position(line, column),
          new vscode.Position(line, column)
        ),
      });

      this.outputChannel.appendLine(
        `Navigated to: ${frame.functionName} at ${frame.filePath}:${frame.line}`
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open file: ${frame.filePath} - ${error}`
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
            <title>Call Stack</title>
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

                /* Stack frame item */
                .frame-item {
                    padding: 8px 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    cursor: pointer;
                    transition: background-color 0.2s ease, transform 0.1s ease;
                    position: relative;
                }

                .frame-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                    transform: translateX(2px);
                }

                .frame-item.current {
                    background-color: var(--vscode-list-activeSelectionBackground);
                    border-left: 3px solid var(--vscode-debugIcon-breakpointForeground);
                }

                .frame-item.current:hover {
                    background-color: var(--vscode-list-activeSelectionBackground);
                }

                .frame-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 4px;
                }

                .frame-index {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    min-width: 24px;
                    height: 18px;
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 3px;
                    font-size: 10px;
                    font-weight: bold;
                    padding: 0 4px;
                }

                .frame-item.current .frame-index {
                    background-color: var(--vscode-debugIcon-breakpointForeground);
                    color: white;
                }

                .frame-arrow {
                    color: var(--vscode-debugIcon-breakpointForeground);
                    font-size: 14px;
                    font-weight: bold;
                }

                .frame-function {
                    font-weight: 500;
                    font-size: 13px;
                    flex: 1;
                }

                .frame-item.current .frame-function {
                    font-weight: 600;
                }

                .frame-item.external .frame-function {
                    font-style: italic;
                    opacity: 0.7;
                }

                .frame-location {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    margin-left: 32px;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }

                .frame-file {
                    color: var(--vscode-textLink-foreground);
                }

                .frame-item.external .frame-location {
                    opacity: 0.6;
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
                <button class="refresh-btn" onclick="refreshCallStack()">Refresh</button>
            </div>
            <div class="container" id="callstack-container">
                <div class="empty-state">
                    <div class="empty-icon">[Stack]</div>
                    <div class="empty-title">No Debug Session</div>
                    <div class="empty-description">Start debugging to see the call stack</div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.type === 'update') {
                        renderCallStack(message.frames, message.isDebugActive);
                    }
                });

                function renderCallStack(frames, isDebugActive) {
                    const container = document.getElementById('callstack-container');

                    if (!isDebugActive || !frames || frames.length === 0) {
                        container.innerHTML = \`
                            <div class="empty-state">
                                <div class="empty-icon">[Stack]</div>
                                <div class="empty-title">No Debug Session</div>
                                <div class="empty-description">Start debugging to see the call stack</div>
                            </div>
                        \`;
                        return;
                    }

                    let html = '';
                    frames.forEach(frame => {
                        const currentClass = frame.isCurrent ? 'current' : '';
                        const externalClass = frame.isExternal ? 'external' : '';
                        const arrow = frame.isCurrent ? '<span class="frame-arrow">▶</span>' : '';

                        // Build location string
                        let location = '';
                        if (frame.filePath) {
                            const fileName = frame.filePath.split('/').pop() || frame.filePath;
                            location = \`<span class="frame-file">\${fileName}\${frame.line ? ':' + frame.line : ''}</span>\`;
                        } else if (frame.isExternal) {
                            location = '<span style="opacity: 0.6;">[External Code]</span>';
                        }

                        // Build tooltip with address
                        const tooltip = frame.address
                            ? \`Address: \${frame.address}\${frame.filePath ? '\\n' + frame.filePath : ''}\`
                            : (frame.filePath || '');

                        html += \`
                            <div class="frame-item \${currentClass} \${externalClass}"
                                 onclick="navigateToFrame(\${frame.index})"
                                 title="\${tooltip}">
                                <div class="frame-header">
                                    \${arrow}
                                    <span class="frame-index">#\${frame.index}</span>
                                    <span class="frame-function">\${frame.functionName}</span>
                                </div>
                                \${location ? \`<div class="frame-location">\${location}</div>\` : ''}
                            </div>
                        \`;
                    });

                    container.innerHTML = html;
                }

                function navigateToFrame(index) {
                    vscode.postMessage({ type: 'navigateToFrame', index: index });
                }

                function refreshCallStack() {
                    vscode.postMessage({ type: 'refresh' });
                }
            </script>
        </body>
        </html>`;
  }
}
