import * as vscode from "vscode";
import { VariableInfo, VariablesData } from "../types/variable";
import { AddressMapper } from "../utils/addressMapper";
import { spawn } from "child_process";
import { DataViewProvider } from "./dataViewProvider";

/**
 * BreakpointsViewProvider manages the breakpoints webview panel
 * Displays breakpoint addresses and device breakpoints
 * Also shows breakpoint addresses when breakpoints are set
 */
export class BreakpointsViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private outputChannel: vscode.OutputChannel;
  private breakpointsData: VariablesData = {
    localVariables: [],
    globalVariables: [],
    totalCount: 0,
    isValid: false,
  };
  private isDebugActive: boolean = false;
  private addressMapper: AddressMapper;
  private swdDebuggerPath: string;
  private deviceBreakpoints: Array<{ slot: number; address: string }> = [];
  private breakpointStates: Map<string, boolean> = new Map();
  private dataViewProvider?: DataViewProvider;

  constructor(
    private readonly extensionUri: vscode.Uri,
    outputChannel: vscode.OutputChannel,
    swdDebuggerPath: string,
    dataViewProvider?: DataViewProvider
  ) {
    this.outputChannel = outputChannel;
    this.addressMapper = new AddressMapper();
    this.swdDebuggerPath = swdDebuggerPath;
    this.dataViewProvider = dataViewProvider;

    // Listen for breakpoint changes and refresh
    vscode.debug.onDidChangeBreakpoints((event) => {
      // Check if breakpoints were added
      if (event.added.length > 0) {
        const totalBreakpoints = vscode.debug.breakpoints.length;
        if (totalBreakpoints > 4) {
          // Remove the newly added breakpoint(s)
          const breakpointsToRemove = event.added;
          vscode.debug.removeBreakpoints(breakpointsToRemove);
          vscode.window.showErrorMessage("You can add max 4 addresses");
          return;
        }
      }
      this.refresh();
    });
  }

  public setDebugActive(isActive: boolean): void {
    this.outputChannel.appendLine(
      `🔴 Breakpoint view debug state: ${isActive ? "ACTIVE" : "INACTIVE"}`
    );
    this.outputChannel.appendLine(
      `🔴 Breakpoint addresses: ${
        this.addressMapper.getBreakpointAddresses().length
      }`
    );
    this.outputChannel.appendLine(
      `🔴 Device breakpoints: ${this.deviceBreakpoints.length}`
    );
    this.isDebugActive = isActive;
    this.refresh();
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
      } else if (message.type === "navigateToBreakpoint") {
        this.navigateToBreakpoint(message.breakpoint);
      } else if (message.type === "toggleBreakpoint") {
        this.toggleBreakpoint(message.address, message.enabled);
      } else if (message.type === "removeBreakpoint") {
        this.removeBreakpoint(message.address, message.file, message.line);
      } else if (message.type === "removeDeviceBreakpoint") {
        this.removeDeviceBreakpoint(message.slot);
      }
    });

    // Initial render
    this.refresh();
  }

  /**
   * Update the breakpoints display
   */
  public updateBreakpoints(data: VariablesData, isActive: boolean) {
    this.breakpointsData = data;
    this.isDebugActive = isActive;
    this.refresh();
  }

  /**
   * Load disassembly for address mapping
   */
  public async loadDisassembly(workspaceRoot: string): Promise<void> {
    const loaded = await this.addressMapper.loadDisassembly(workspaceRoot);
    if (loaded) {
      this.outputChannel.appendLine("✅ Address mapper loaded successfully");
      this.refresh();
    } else {
      this.outputChannel.appendLine(
        "⚠️  Could not load disassembly for address mapping"
      );
    }
  }

  /**
   * Update device breakpoints by executing swd-debugger bp --list
   */
  public async updateDeviceBreakpoints(): Promise<void> {
    try {
      this.outputChannel.appendLine("📍 Fetching device breakpoints...");
      const output = await this.executeSwdCommand(["bp", "--list"]);

      // Parse the output
      this.deviceBreakpoints = this.parseBreakpointList(output);

      this.outputChannel.appendLine(
        `✅ Device breakpoints updated: ${this.deviceBreakpoints.length} breakpoints`
      );
      this.refresh();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(
        `❌ Failed to fetch device breakpoints: ${errorMsg}`
      );
      this.deviceBreakpoints = [];
      this.refresh();
    }
  }

  /**
   * Parse breakpoint list output from swd-debugger bp --list
   */
  private parseBreakpointList(
    output: string
  ): Array<{ slot: number; address: string }> {
    const breakpoints: Array<{ slot: number; address: string }> = [];
    const lines = output.split("\n");

    for (const line of lines) {
      // Match lines that contain "Slot X: ENABLED at 0xABCD"
      // Extract both slot number and address
      const match = line.match(
        /Slot\s+(\d+):\s+ENABLED\s+at\s+(0x[0-9a-fA-F]+)/i
      );
      if (match) {
        breakpoints.push({
          slot: parseInt(match[1]),
          address: match[2],
        });
      }
    }

    return breakpoints;
  }

  /**
   * Refresh the webview with current data
   */
  public refresh() {
    if (!this._view) {
      this.outputChannel.appendLine(
        "❌ BreakpointsViewProvider: No view available"
      );
      return;
    }

    const breakpointAddresses = this.addressMapper.getBreakpointAddresses();

    this.outputChannel.appendLine(`🔄 BreakpointsViewProvider refresh:`);
    this.outputChannel.appendLine(`   - isDebugActive: ${this.isDebugActive}`);
    this.outputChannel.appendLine(
      `   - breakpointAddresses: ${breakpointAddresses.length}`
    );
    this.outputChannel.appendLine(
      `   - deviceBreakpoints: ${this.deviceBreakpoints.length}`
    );
    this.outputChannel.appendLine(`   - _view.visible: ${this._view.visible}`);

    // Convert Map to plain object for JSON serialization
    const breakpointStatesObj: { [key: string]: boolean } = {};
    this.breakpointStates.forEach((value, key) => {
      breakpointStatesObj[key] = value;
    });

    try {
      this._view.webview.postMessage({
        type: "update",
        data: this.breakpointsData,
        isDebugActive: this.isDebugActive,
        breakpointAddresses: breakpointAddresses,
        deviceBreakpoints: this.deviceBreakpoints,
        breakpointStates: breakpointStatesObj,
      });
      this.outputChannel.appendLine("✅ Message sent to webview successfully");
    } catch (error) {
      this.outputChannel.appendLine(
        `❌ Failed to send message to webview: ${error}`
      );
    }
  }

  /**
   * Navigate to source location of a breakpoint
   */
  private async navigateToBreakpoint(breakpoint: VariableInfo) {
    if (!breakpoint.filePath || !breakpoint.line) {
      vscode.window.showInformationMessage(
        `No source location available for breakpoint: ${breakpoint.name}`
      );
      return;
    }

    try {
      // Try to resolve the file path
      const uri = this.resolveFilePath(breakpoint.filePath);
      if (!uri) {
        vscode.window.showWarningMessage(
          `Could not find file: ${breakpoint.filePath}`
        );
        return;
      }

      // Open the document and navigate to the line
      const document = await vscode.workspace.openTextDocument(uri);
      const line = breakpoint.line - 1; // Convert to 0-based

      await vscode.window.showTextDocument(document, {
        selection: new vscode.Range(
          new vscode.Position(line, 0),
          new vscode.Position(line, 0)
        ),
      });

      this.outputChannel.appendLine(
        `Navigated to: ${breakpoint.name} at ${breakpoint.filePath}:${breakpoint.line}`
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open file: ${breakpoint.filePath} - ${error}`
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
   * Toggle breakpoint on/off and execute corresponding swd-debugger command
   */
  private async toggleBreakpoint(address: string, enabled: boolean) {
    if (!address || address === "N/A") {
      vscode.window.showWarningMessage(
        "Address not mapped. Please connect device and run debug again."
      );
      this.outputChannel.appendLine(
        `⚠️  Cannot toggle breakpoint - address not mapped`
      );
      return;
    }

    // Save checkbox state
    this.breakpointStates.set(address, enabled);

    try {
      if (enabled) {
        // Enable breakpoint: swd-debugger bp 0x08000100 ${address}
        this.outputChannel.appendLine(
          `📍 Enabling breakpoint at ${address}...`
        );
        await this.executeSwdCommand(["bp", address]);

        this.outputChannel.appendLine(`✅ Breakpoint enabled at ${address}`);
        vscode.window.showInformationMessage(
          `Breakpoint enabled at ${address}`
        );

        // Update device breakpoints and refresh UI
        const output = await this.executeSwdCommand(["bp", "--list"]);
        this.deviceBreakpoints = this.parseBreakpointList(output);
        this.outputChannel.appendLine(
          `✅ Device breakpoints updated: ${this.deviceBreakpoints.length} breakpoints`
        );
        this.refresh();

        // Automatically refresh the Data View (Variables) after breakpoint is enabled
        if (this.dataViewProvider) {
          this.outputChannel.appendLine(
            `🔄 Auto-refreshing Data View after breakpoint enable...`
          );
          await this.dataViewProvider.updateAll();
        }
      } else {
        // Disable breakpoint: swd-debugger bp --clear ${address}
        this.outputChannel.appendLine(
          `📍 Disabling breakpoint at ${address}...`
        );
        await this.executeSwdCommand(["bp", "--clear", address]);
        this.outputChannel.appendLine(`✅ Breakpoint cleared at ${address}`);

        vscode.window.showInformationMessage(
          `Breakpoint cleared at ${address}`
        );

        // Update device breakpoints and refresh UI
        const output = await this.executeSwdCommand(["bp", "--list"]);
        this.deviceBreakpoints = this.parseBreakpointList(output);
        this.outputChannel.appendLine(
          `✅ Device breakpoints updated: ${this.deviceBreakpoints.length} breakpoints`
        );
        this.refresh();

        // Automatically refresh the Data View (Variables) after breakpoint is disabled
        if (this.dataViewProvider) {
          this.outputChannel.appendLine(
            `🔄 Auto-refreshing Data View after breakpoint disable...`
          );
          await this.dataViewProvider.updateAll();
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(
        `❌ Failed to toggle breakpoint: ${errorMsg}`
      );
      vscode.window.showErrorMessage(
        `Failed to toggle breakpoint: ${errorMsg}`
      );
    }
  }

  /**
   * Remove device breakpoint by slot number
   */
  private async removeDeviceBreakpoint(slot: number) {
    try {
      this.outputChannel.appendLine(
        `🗑️  Clearing device breakpoint at slot ${slot}...`
      );

      await this.executeSwdCommand([
        "bp",
        "--clear",
        "--slot",
        slot.toString(),
      ]);

      this.outputChannel.appendLine(
        `✅ Device breakpoint cleared at slot ${slot}`
      );
      vscode.window.showInformationMessage(
        `Device breakpoint cleared at slot ${slot}`
      );

      // Update device breakpoints and refresh UI
      const output = await this.executeSwdCommand(["bp", "--list"]);
      this.deviceBreakpoints = this.parseBreakpointList(output);
      this.outputChannel.appendLine(
        `✅ Device breakpoints updated: ${this.deviceBreakpoints.length} breakpoints`
      );
      this.refresh();

      // Automatically refresh the Data View (Variables) after device breakpoint is removed
      if (this.dataViewProvider) {
        this.outputChannel.appendLine(
          `🔄 Auto-refreshing Data View after device breakpoint removal...`
        );
        await this.dataViewProvider.updateAll();
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(
        `❌ Failed to clear device breakpoint: ${errorMsg}`
      );
      vscode.window.showErrorMessage(
        `Failed to clear device breakpoint: ${errorMsg}`
      );
    }
  }

  /**
   * Remove breakpoint from VS Code and execute swd-debugger bp --clear command
   */
  private async removeBreakpoint(address: string, file: string, line: number) {
    try {
      // Find and remove the breakpoint from VS Code
      const allBreakpoints = vscode.debug.breakpoints;
      const breakpointToRemove = allBreakpoints.find((bp) => {
        if (bp instanceof vscode.SourceBreakpoint) {
          const bpFile = bp.location.uri.fsPath;
          const bpLine = bp.location.range.start.line + 1; // Convert to 1-based
          return bpFile.endsWith(file) && bpLine === line;
        }
        return false;
      });

      if (breakpointToRemove) {
        vscode.debug.removeBreakpoints([breakpointToRemove]);
        this.outputChannel.appendLine(
          `🗑️  Removed breakpoint from VS Code: ${file}:${line}`
        );
      }

      // Execute swd-debugger bp --clear command if address is available
      if (address && address !== "N/A") {
        // Remove from breakpoint states
        this.breakpointStates.delete(address);

        this.outputChannel.appendLine(
          `🗑️  Clearing device breakpoint at ${address}...`
        );
        await this.executeSwdCommand(["bp", "--clear", address]);
        this.outputChannel.appendLine(
          `✅ Device breakpoint cleared at ${address}`
        );
        vscode.window.showInformationMessage(
          `Breakpoint removed at ${address}`
        );

        // Update device breakpoints and refresh UI
        const output = await this.executeSwdCommand(["bp", "--list"]);
        this.deviceBreakpoints = this.parseBreakpointList(output);
        this.outputChannel.appendLine(
          `✅ Device breakpoints updated: ${this.deviceBreakpoints.length} breakpoints`
        );
      } else {
        vscode.window.showInformationMessage(`Breakpoint removed from VS Code`);
      }

      this.refresh();

      // Automatically refresh the Data View (Variables) after breakpoint is removed
      if (this.dataViewProvider) {
        this.outputChannel.appendLine(
          `🔄 Auto-refreshing Data View after breakpoint removal...`
        );
        await this.dataViewProvider.updateAll();
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(
        `❌ Failed to remove breakpoint: ${errorMsg}`
      );
      vscode.window.showErrorMessage(
        `Failed to remove breakpoint: ${errorMsg}`
      );
    }
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
        this.outputChannel.append(output);
      });

      process.stderr.on("data", (data) => {
        const output = data.toString();
        stderr += output;
        this.outputChannel.append(output);
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
            <title>Breakpoints</title>
            <style>
                /* Your existing CSS styles here - keep them all */
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

                /* Breakpoint styling */
                .breakpoint-item {
                    display: flex;
                    align-items: center;
                    padding: 8px 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
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
                    font-size: 12px;
                    cursor: pointer;
                }

                .breakpoint-item.disabled {
                    opacity: 0.5;
                }

                .breakpoint-close-btn {
                    background: transparent;
                    border: none;
                    color: var(--vscode-descriptionForeground);
                    cursor: pointer;
                    font-size: 16px;
                    padding: 2px 6px;
                    margin-left: 8px;
                    border-radius: 3px;
                    transition: background-color 0.2s ease, color 0.2s ease;
                }

                .breakpoint-close-btn:hover {
                    background-color: var(--vscode-inputValidation-errorBackground);
                    color: var(--vscode-errorForeground);
                }

                .device-breakpoints-section {
                    margin-top: 20px;
                }

                /* Debug info styling */
                .debug-info {
                    background-color: var(--vscode-inputValidation-infoBackground);
                    border: 1px solid var(--vscode-inputValidation-infoBorder);
                    padding: 8px;
                    margin: 8px 0;
                    border-radius: 4px;
                    font-size: 11px;
                    font-family: 'Courier New', monospace;
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
                <button class="refresh-btn" onclick="refreshBreakpoints()">🔄 Refresh</button>
            </div>
            <div class="container" id="breakpoints-container">
                <div class="empty-state">
                    <div class="empty-icon">📋</div>
                    <div class="empty-title">No Debug Session</div>
                    <div class="empty-description">Start debugging to see Breakpoints</div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                let lastMessage = null;

                window.addEventListener('message', event => {
                    const message = event.data;
                    console.log('📨 Webview received message:', message.type);
                    console.log('   isDebugActive:', message.isDebugActive);
                    console.log('   breakpointAddresses count:', message.breakpointAddresses?.length);
                    console.log('   deviceBreakpoints count:', message.deviceBreakpoints?.length);
                    
                    lastMessage = message;
                    
                    if (message.type === 'update') {
                        renderBreakpoints(message.data, message.isDebugActive, message.breakpointAddresses, message.deviceBreakpoints, message.breakpointStates);
                    }
                });

                function renderBreakpoints(data, isDebugActive, breakpointAddresses, deviceBreakpoints, breakpointStates) {
                  console.log('🎨 Rendering breakpoints:', {
                    isDebugActive: isDebugActive,
                    breakpointAddresses: breakpointAddresses,
                    deviceBreakpoints: deviceBreakpoints
                  });
                  
                  const container = document.getElementById('breakpoints-container');
                  let html = '';

                  // If debug is NOT active, show the "No Debug Session " message
                  if (!isDebugActive) {
                      html = '<div class="empty-state">' +
                          '<div class="empty-icon">📋</div>' +
                          '<div class="empty-title">No Debug Session</div>' +
                          '<div class="empty-description">Start debugging to see Breakpoints</div>' +
                          '</div>';
                  } 
                  // If debug IS active but no breakpoints, show appropriate message
                  else if ((!breakpointAddresses || breakpointAddresses.length === 0) && 
                           (!deviceBreakpoints || deviceBreakpoints.length === 0)) {
                      html = '<div class="empty-state">' +
                          '<div class="empty-icon">📋</div>' +
                          '<div class="empty-title">No Breakpoints Set</div>' +
                          '<div class="empty-description">Click in the gutter to set breakpoints</div>' +
                          '</div>';
                  }
                  // Debug is active AND we have breakpoints to show
                  else {
                      // Show breakpoint addresses if any
                      if (breakpointAddresses && breakpointAddresses.length > 0) {
                          breakpointAddresses.forEach(function(bp) {
                              const label = bp.functionName ? bp.functionName : (bp.file + ':' + bp.line);
                              const address = bp.address || 'N/A';
                              const hasAddress = address !== 'N/A';
                              const disabledClass = !hasAddress ? 'disabled' : '';

                              // Restore checkbox state from breakpointStates
                              const isChecked = breakpointStates && breakpointStates[address] === true;
                              const checkedAttr = isChecked ? 'checked' : '';

                              html += '<div class="breakpoint-item ' + disabledClass + '">' +
                                  '<input type="checkbox" ' +
                                  'class="breakpoint-checkbox" ' +
                                  'onchange="toggleBreakpoint(\\'' + address + '\\', this.checked)" ' +
                                  ((!hasAddress) ? 'disabled ' : '') +
                                  checkedAttr + '>' +
                                  '<span class="breakpoint-label">' + label + '</span>' +
                                  '<span class="variable-address">' + address + '</span>' +
                                  '<button class="breakpoint-close-btn" ' +
                                  'onclick="removeBreakpoint(\\'' + address + '\\', \\'' + bp.file + '\\', ' + bp.line + '); event.stopPropagation();" ' +
                                  'title="Remove breakpoint">✕</button>' +
                                  '</div>';
                          });
                      }

                      // Show device breakpoints if any
                      if (deviceBreakpoints && deviceBreakpoints.length > 0) {
                          html += '<div class="section-header device-breakpoints-section">' +
                              '<span>Device Breakpoints</span>' +
                              '<span class="section-count">' + deviceBreakpoints.length + '</span>' +
                              '</div>';

                          deviceBreakpoints.forEach(function(bp) {
                              html += '<div class="breakpoint-item">' +
                                  '<span class="breakpoint-label">Slot ' + bp.slot + '</span>' +
                                  '<span class="variable-address">' + bp.address + '</span>' +
                                  '<button class="breakpoint-close-btn" ' +
                                  'onclick="removeDeviceBreakpoint(' + bp.slot + '); event.stopPropagation();" ' +
                                  'title="Remove device breakpoint">✕</button>' +
                                  '</div>';
                          });
                      }

                      // Add debug info
                      html += '<div class="debug-info">' +
                          'Debug State: ACTIVE | ' +
                          'Breakpoints: ' + (breakpointAddresses ? breakpointAddresses.length : 0) + ' | ' +
                          'Device BPs: ' + (deviceBreakpoints ? deviceBreakpoints.length : 0) +
                          '</div>';
                  }

                  container.innerHTML = html;
                  console.log('✅ Render completed. HTML length:', html.length);
              }

                function navigateToBreakpoint(breakpoint) {
                    vscode.postMessage({ type: 'navigateToBreakpoint', breakpoint: breakpoint });
                }

                function toggleBreakpoint(address, enabled) {
                    vscode.postMessage({ type: 'toggleBreakpoint', address: address, enabled: enabled });
                }

                function removeBreakpoint(address, file, line) {
                    vscode.postMessage({ type: 'removeBreakpoint', address: address, file: file, line: line });
                }

                function removeDeviceBreakpoint(slot) {
                    vscode.postMessage({ type: 'removeDeviceBreakpoint', slot: slot });
                }

                function refreshBreakpoints() {
                    vscode.postMessage({ type: 'refresh' });
                }

                // Log when the webview is loaded
                console.log('🔄 Breakpoints webview loaded and ready');
                if (lastMessage) {
                    console.log('📋 Last message available, re-rendering...');
                    renderBreakpoints(lastMessage.data, lastMessage.isDebugActive, lastMessage.breakpointAddresses, lastMessage.deviceBreakpoints, lastMessage.breakpointStates);
                }
            </script>
        </body>
        </html>`;
  }
}
