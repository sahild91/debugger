import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";
import { Port11TreeViewProvider } from "./views/port11TreeView";
import { ConsoleViewProvider } from "./views/consoleViewProvider";
import { CallStackViewProvider } from "./views/callStackViewProvider";
import { BreakpointsViewProvider } from "./views/breakpointViewProvider";
import { BoardsViewProvider } from "./views/boardsViewProvider";
import { SetupViewProvider } from "./views/setupViewProvider";
import { DataViewProvider } from "./views/dataViewProvider";
import { TopToolbarProvider } from "./views/topToolbarProvider";
import { SDKManager } from "./managers/sdkManager";
import { ToolchainManager } from "./managers/toolchainManager";
import { SysConfigManager } from "./managers/sysconfigManager";
import { CliManager } from "./managers/cliManager";
import { ConnectionManager } from "./managers/connectionManager";
import { BuildCommand } from "./commands/buildCommand";
import { FlashCommand } from "./commands/flashCommand";
import { DebugCommand } from "./commands/debugCommand";
import { detectEntryPoint } from "./utils/entryPointFinder";

let outputChannel: vscode.OutputChannel;
let treeViewProvider: Port11TreeViewProvider;
let consoleViewProvider: ConsoleViewProvider;
let callStackViewProvider: CallStackViewProvider;
let breakpointsViewProvider: BreakpointsViewProvider;
let boardsViewProvider: BoardsViewProvider;
let setupViewProvider: SetupViewProvider;
let dataViewProvider: DataViewProvider;
let topToolbarProvider: TopToolbarProvider;
let sdkManager: SDKManager;
let toolchainManager: ToolchainManager;
let sysConfigManager: SysConfigManager;
let cliManager: CliManager;
let connectionManager: ConnectionManager;
let statusBarItem: vscode.StatusBarItem;
let connectStatusBar: vscode.StatusBarItem;
let debugCommand: DebugCommand;
let currentPCDecoration: vscode.TextEditorDecorationType | undefined;

// Parse disassembly file to find source location for a PC address
async function findSourceLocationForPC(
  pcAddress: string,
  outputChannel: vscode.OutputChannel
): Promise<{ file: string; line: number; functionName?: string } | undefined> {
  try {
    outputChannel.appendLine(`Looking up PC address: ${pcAddress}`);

    // FAST PATH: Try addressMapper first (already loaded in memory)
    if (breakpointsViewProvider) {
      const addressMapper = (breakpointsViewProvider as any).addressMapper;

      if (addressMapper && addressMapper.isLoaded()) {
        outputChannel.appendLine(`Using fast path: addressMapper lookup`);

        // Debug: Show mapper stats
        const stats = addressMapper.getStats();
        outputChannel.appendLine(
          `   Mapper has ${stats.totalMappings} mappings loaded`
        );

        const result = addressMapper.getSourceLocationForAddress(pcAddress);

        if (result) {
          outputChannel.appendLine(
            `Fast path found: ${result.file}:${result.line}${
              result.functionName ? ` (${result.functionName})` : ""
            }`
          );
          return result;
        } else {
          outputChannel.appendLine(`Fast path: address not found in mapper`);

          // Debug: Try to see what addresses are near this one
          outputChannel.appendLine(`   Searching for PC: ${pcAddress}`);
          outputChannel.appendLine(
            `   Normalized: ${pcAddress.replace(/^0x/i, "").toLowerCase()}`
          );

          // Show sample of what's in the map
          const sampleAddresses = addressMapper.getSampleAddresses(5);
          outputChannel.appendLine(
            `   Sample addresses in map: ${sampleAddresses.join(", ")}`
          );
        }
      } else {
        outputChannel.appendLine(
          `Fast path unavailable: addressMapper not loaded, using fallback...`
        );
      }
    } else {
      outputChannel.appendLine(
        `Fast path unavailable: breakpointsViewProvider not initialized, using fallback...`
      );
    }

    // FALLBACK: Parse full_disasm.txt file
    outputChannel.appendLine(`Using fallback: parsing full_disasm.txt`);

    // Convert PC address format: 0x000002A4 -> 2a4
    const cleanAddress = pcAddress.replace("0x", "").toLowerCase();

    // Get workspace folder
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      outputChannel.appendLine("No workspace folder found");
      return undefined;
    }

    // Read disassembly file
    const disasmPath = `${workspaceFolder}/full_disasm.txt`;
    const fs = require("fs");

    if (!fs.existsSync(disasmPath)) {
      outputChannel.appendLine(`Disassembly file not found: ${disasmPath}`);
      return undefined;
    }

    const content = fs.readFileSync(disasmPath, "utf8");
    const lines = content.split("\n");

    let functionName: string | undefined;

    // Step 1: Find the function at this address (e.g., "000002a4 <DL_GPIO_clearPins>:")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Look for function definition line (format: "000002a4 <DL_GPIO_clearPins>:")
      const funcMatch = line.match(/^([0-9a-f]+)\s+<([^>]+)>:/);

      if (funcMatch) {
        const funcAddress = funcMatch[1];
        const funcName = funcMatch[2];

        // Check if this is the address we're looking for
        if (parseInt(funcAddress, 16) === parseInt(cleanAddress, 16)) {
          functionName = funcName;
          outputChannel.appendLine(
            `Found function at address: ${funcName} at ${funcAddress}`
          );
          break;
        }
      }
    }

    if (!functionName) {
      outputChannel.appendLine(`No function found at address ${cleanAddress}`);
      return undefined;
    }

    // Step 2: Search backwards for "bl 0x2a4 <functionName>" to find the call site
    outputChannel.appendLine(`Searching for call to function: ${functionName}`);

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];

      // Look for branch/call instruction to this function
      // Format: "     132: f000 f89f        bl    0x274 <DL_GPIO_setPins> @ imm = #0x13e"
      // OR:     "     abc: 1234             bl    0x274 <DL_GPIO_setPins> @ imm = #0x13e"
      // Match one or more hex groups before 'bl'
      const callMatch = line.match(
        /^\s*([0-9a-f]+):\s+[0-9a-f\s]+\s+bl\s+0x([0-9a-f]+)\s+<([^>]+)>/
      );

      if (callMatch) {
        const callAddress = callMatch[1];
        const calledFunc = callMatch[3];

        // Check if this calls our function
        if (calledFunc === functionName) {
          outputChannel.appendLine(
            `Found call to ${functionName} at address ${callAddress}`
          );

          // Look backwards for source location comment
          // Format: "; /path/to/file.c:60"
          // The comment can be several lines before the bl instruction
          for (let j = i - 1; j >= Math.max(0, i - 20); j--) {
            const commentLine = lines[j];

            // Match source location comment
            const sourceMatch = commentLine.match(/;\s*(.+):(\d+)\s*$/);

            if (sourceMatch) {
              const file = sourceMatch[1].trim();
              const lineNum = parseInt(sourceMatch[2], 10);

              outputChannel.appendLine(
                `Found source location: ${file}:${lineNum}`
              );

              return { file, line: lineNum, functionName };
            }

            // Don't stop on instruction lines - keep looking backwards
            // The source comment might be several instructions before the bl
          }
        }
      }
    }

    outputChannel.appendLine(
      `Could not find call site for function ${functionName}`
    );
    return undefined;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Error parsing disassembly: ${errorMsg}`);
    return undefined;
  }
}

// Show arrow icon in gutter at current PC location
async function showArrowAtPC(
  pcAddress: string,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  try {
    outputChannel.appendLine(`Showing arrow at PC: ${pcAddress}`);

    // Clear previous arrow decoration
    if (currentPCDecoration) {
      currentPCDecoration.dispose();
      currentPCDecoration = undefined;
    }

    // Find source location from disassembly
    const location = await findSourceLocationForPC(pcAddress, outputChannel);

    if (!location) {
      outputChannel.appendLine("Could not find source location for PC");
      return;
    }

    // Resolve file path
    let fileUri: vscode.Uri;
    if (location.file.startsWith("/") || location.file.match(/^[a-zA-Z]:[/\\]/)) {
      // Absolute path (Unix: /path or Windows: C:/ or C:\)
      fileUri = vscode.Uri.file(location.file);
    } else {
      // Relative path
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        outputChannel.appendLine("No workspace folder found");
        return;
      }
      fileUri = vscode.Uri.joinPath(workspaceFolder.uri, location.file);
    }

    // Open the document
    const document = await vscode.workspace.openTextDocument(fileUri);
    const line = location.line - 1; // Convert to 0-based

    // Show the document
    const editor = await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, 0)
      ),
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });

    // Create arrow decoration in gutter with light yellow background
    currentPCDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.parse(
        "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cG9seWdvbiBwb2ludHM9IjEsMiAxLDE0IDEyLDggMSwyIiBmaWxsPSIjZmZjYzAwIi8+PC9zdmc+"
      ),
      gutterIconSize: "contain",
      isWholeLine: true,
      backgroundColor: "rgba(255, 255, 0, 0.2)", // Light yellow background
      overviewRulerColor: new vscode.ThemeColor(
        "editorOverviewRuler.infoForeground"
      ),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    // Apply decoration
    editor.setDecorations(currentPCDecoration, [
      new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, 0)
      ),
    ]);

    outputChannel.appendLine(
      `Arrow shown at ${location.file}:${location.line}`
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Error showing arrow at PC: ${errorMsg}`);
  }
}

function getAbsolutePath(relativePath: string): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspaceFolder) {
    throw new Error("No workspace folder open");
  }

  // ✅ path.join handles spaces correctly
  const absolutePath = path.join(workspaceFolder, relativePath);

  // ✅ Verify file exists
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  return absolutePath;
}

function executeSwdDebuggerCommand(
  args: string[], // ✅ Changed from string to string[]
  successMessage: string,
  requiresPort: boolean = true,
  requiresWorkspace: boolean = false
): Promise<void> {
  return new Promise((resolve, reject) => {
    const executablePath = cliManager.getExecutablePath(); // ✅ Use unsanitized for spawn
    const selectedPort = connectionManager.getSelectedPort();

    // Validate port requirement
    if (requiresPort && !selectedPort) {
      const errorMessage =
        "No port connected. Please select a port first using the Connect button.";
      outputChannel.appendLine(`ERROR: ${errorMessage}`);
      vscode.window
        .showErrorMessage(errorMessage, "Connect Port")
        .then((selection) => {
          if (selection === "Connect Port") {
            vscode.commands.executeCommand("extension.connectCommand");
          }
        });
      reject(new Error(errorMessage));
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;

    // Only check for workspace folder if explicitly required
    if (requiresWorkspace && !workspaceFolder) {
      const errorMessage =
        "No workspace folder open. Cannot determine file paths.";
      outputChannel.appendLine(`ERROR: ${errorMessage}`);
      vscode.window.showErrorMessage(errorMessage);
      reject(new Error(errorMessage));
      return;
    }

    // Build arguments array
    const fullArgs: string[] = [];

    if (selectedPort) {
      fullArgs.push("--port", selectedPort);
    }

    fullArgs.push(...args); // ✅ Spread the args array

    outputChannel.appendLine(`Executing: ${executablePath}`);
    outputChannel.appendLine(`Arguments: ${fullArgs.join(" ")}`);

    // ✅ Use spawn instead of exec
    const swdProcess = spawn(executablePath, fullArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workspaceFolder || undefined,
    });

    let stdout = "";
    let stderr = "";

    swdProcess.stdout.on("data", (data: { toString: () => any }) => {
      const output = data.toString();
      stdout += output;
      outputChannel.append(output);
    });

    swdProcess.stderr.on("data", (data: { toString: () => any }) => {
      const output = data.toString();
      stderr += output;
      outputChannel.append(output);
    });

    swdProcess.on("close", (code: number) => {
      if (code === 0) {
        outputChannel.appendLine(successMessage);
        vscode.window.showInformationMessage(successMessage);
        resolve();
      } else {
        const errorMessage = `Command failed with exit code ${code}`;
        outputChannel.appendLine(`ERROR: ${errorMessage}`);
        if (stderr) {
          outputChannel.appendLine(`Stderr: ${stderr}`);
        }
        vscode.window.showErrorMessage(errorMessage);
        reject(new Error(errorMessage));
      }
    });

    interface SwdProcessError extends Error {
      code?: string;
      errno?: string;
      syscall?: string;
    }

    swdProcess.on("error", (error: SwdProcessError) => {
      const errorMessage: string = `Process error: ${error.message}`;
      outputChannel.appendLine(`ERROR: ${errorMessage}`);
      vscode.window.showErrorMessage(errorMessage);
      reject(error);
    });
  });
}

export async function activate(context: vscode.ExtensionContext) {
  // Initialize base output channel for logging
  const baseOutputChannel =
    vscode.window.createOutputChannel("Port11 Debugger");

  // Create a wrapper that logs to both Output Channel and Console View
  // This allows all existing code to work without changes
  outputChannel = {
    // Core logging methods
    appendLine: (value: string) => {
      baseOutputChannel.appendLine(value);
      // Also send to console view (will be initialized later)
      consoleViewProvider?.addLog(value);
    },
    append: (value: string) => {
      baseOutputChannel.append(value);
      // Note: append doesn't add newline, so we send to console only on appendLine
    },

    // Display methods
    show: (preserveFocus?: boolean) => baseOutputChannel.show(preserveFocus),
    hide: () => baseOutputChannel.hide(),

    // Clear method - clears both output channel and console view
    clear: () => {
      baseOutputChannel.clear();
      consoleViewProvider?.clearLogs();
    },

    // Cleanup
    dispose: () => baseOutputChannel.dispose(),

    // Properties
    name: baseOutputChannel.name,

    // Replace method
    replace: (value: string) => baseOutputChannel.replace(value),
  } as vscode.OutputChannel;

  // Show output channel only in debug mode or if specified in settings
  const showLogsOnStartup = vscode.workspace
    .getConfiguration("port11-debugger")
    .get("showLogsOnStartup", false);
  if (showLogsOnStartup) {
    outputChannel.show();
  }

  outputChannel.appendLine("Port11 Debugger extension activated");
  outputChannel.appendLine(`VS Code version: ${vscode.version}`);
  outputChannel.appendLine(`Extension path: ${context.extensionPath}`);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    101
  );
  statusBarItem.command = "port11-debugger.refreshStatus";
  statusBarItem.tooltip = "Port11 Debugger - Click to refresh status";
  updateStatusBar("Initializing...");

  // Flash command
  let flashDisposable = vscode.commands.registerCommand(
    "extension.flashCommand",
    async () => {
      try {
        outputChannel.appendLine("Flash command triggered");
        outputChannel.show();

        // Detect entry point to determine hex file name
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
          throw new Error("No workspace folder open");
        }

        const entryPoint = await detectEntryPoint(workspaceFolder, outputChannel);
        if (!entryPoint) {
          throw new Error("Could not detect entry point file. Please ensure your project has a main() function.");
        }

        const hexFileName = `build/${entryPoint.baseName}.hex`;
        const binPath = getAbsolutePath(hexFileName);

        outputChannel.appendLine(`Using hex file: ${hexFileName}`);

        await executeSwdDebuggerCommand(
          ["flash", "--file", binPath],
          "Flash completed successfully!",
          true,
          true
        );
      } catch (error) {
        outputChannel.appendLine(`ERROR: Flash command failed: ${error}`);
        vscode.window.showErrorMessage(`Flash failed: ${error}`);
      }
    }
  );

  // Halt command
  let haltDisposable = vscode.commands.registerCommand(
    "extension.haltCommand",
    async () => {
      try {
        outputChannel.appendLine("Halt command triggered");
        outputChannel.show();

        // ✅ Use debugCommand.halt() instead of executeSwdDebuggerCommand()
        await debugCommand.halt();

        // Update registry data in DataViewProvider when halted
        try {
          await dataViewProvider?.updateRegistryData();
        } catch (error) {
          outputChannel.appendLine(`Failed to update registry data: ${error}`);
        }

        // Update variables in DataViewProvider when paused
        try {
          const variables = await debugCommand.getVariables();
          dataViewProvider?.updateVariables(
            variables.localVariables,
            variables.globalVariables,
            true
          );
        } catch (error) {
          outputChannel.appendLine(`Failed to update variables: ${error}`);
        }

        // Update call stack when paused
        try {
          const callStack = await debugCommand.getCallStack();
          callStackViewProvider?.updateCallStack(callStack, true);
        } catch (error) {
          outputChannel.appendLine(`Failed to update call stack: ${error}`);
        }

        // Show success message
        vscode.window.showInformationMessage("Target halted successfully!");
        // Show arrow at current PC location
        try {
          const pc = await debugCommand.readPC();
          await showArrowAtPC(pc, outputChannel);
        } catch (error) {
          outputChannel.appendLine(`Failed to show arrow at PC: ${error}`);
        }
      } catch (error) {
        outputChannel.appendLine(`ERROR: Halt command failed: ${error}`);
        vscode.window.showErrorMessage(`Halt failed: ${error}`);
      }
    }
  );

  // Resume command
  let resumeDisposable = vscode.commands.registerCommand(
    "extension.resumeCommand",
    async () => {
      try {
        outputChannel.appendLine("Resume command triggered");
        outputChannel.show();

        // ✅ Use debugCommand.resume() instead of executeSwdDebuggerCommand()
        await debugCommand.resume();

        // Note: Don't update UI here - wait for breakpoint hit or halt
        vscode.window.showInformationMessage(
          "Target resumed - monitoring for breakpoints..."
        );

        outputChannel.appendLine(
          "⏸️ Target halted after resume - updating variables..."
        );

        // Update registry data in DataViewProvider
        try {
          await dataViewProvider?.updateRegistryData();
        } catch (error) {
          outputChannel.appendLine(`Failed to update registry data: ${error}`);
        }

        // Update variables in DataViewProvider
        try {
          const variables = await debugCommand.getVariables();
          dataViewProvider?.updateVariables(
            variables.localVariables,
            variables.globalVariables,
            true
          );
        } catch (error) {
          outputChannel.appendLine(`Failed to update variables: ${error}`);
        }

        // Update call stack
        try {
          const callStack = await debugCommand.getCallStack();
          callStackViewProvider?.updateCallStack(callStack, true);
        } catch (error) {
          outputChannel.appendLine(`Failed to update call stack: ${error}`);
        }

        // Show arrow at current PC location
        try {
          const pc = await debugCommand.readPC();
          await showArrowAtPC(pc, outputChannel);
        } catch (error) {
          outputChannel.appendLine(`Failed to show arrow at PC: ${error}`);
        }
      } catch (error) {
        outputChannel.appendLine(`Resume command failed: ${error}`);
        vscode.window.showErrorMessage(`Resume failed: ${error}`);
      }
    }
  );

  // Erase command
  let eraseDisposable = vscode.commands.registerCommand(
    "extension.eraseCommand",
    async () => {
      try {
        outputChannel.appendLine("Erase command triggered");
        outputChannel.show();
        await executeSwdDebuggerCommand(
          ["erase", "0x00000000", "0x0001FFFF"],
          "Flash memory erased successfully!"
        );
      } catch (error) {
        outputChannel.appendLine(`Erase command failed: ${error}`);
      }
    }
  );

  // Connect command
  let connectDisposable = vscode.commands.registerCommand(
    "extension.connectCommand",
    async () => {
      try {
        outputChannel.appendLine("Connect command triggered");
        outputChannel.show();

        // Check if already connected and offer disconnect option
        if (connectionManager.isPortSelected()) {
          const currentPort = connectionManager.getPortStatusText();
          const action = await vscode.window.showQuickPick(
            [
              {
                label: "Select Different Port",
                description: "Choose a new serial port",
              },
              {
                label: "Disconnect",
                description: `Disconnect from ${currentPort}`,
              },
            ],
            {
              placeHolder: `Currently connected to ${currentPort}`,
              title: "Port Connection",
            }
          );

          if (action?.label.includes("Disconnect")) {
            connectionManager.disconnect();
            updateConnectStatusBar();
            treeViewProvider.refresh();
            return;
          } else if (!action?.label.includes("Different")) {
            return; // User cancelled
          }
        }

        const selectedPort = await connectionManager.showPortSelection();
        if (selectedPort) {
          outputChannel.appendLine(`Selected port: ${selectedPort}`);
          // Update connect status bar to show selected port
          updateConnectStatusBar();
          treeViewProvider.refresh();
        } else {
          outputChannel.appendLine("No port selected");
        }
      } catch (error) {
        outputChannel.appendLine(`Connect command failed: ${error}`);
      }
    }
  );

  context.subscriptions.push(
    flashDisposable,
    haltDisposable,
    resumeDisposable,
    eraseDisposable,
    connectDisposable
  );

  // Create and show the status bar items
  const buildStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  buildStatusBar.text = "$(tools) Build";
  buildStatusBar.command = "extension.buildCommand";
  buildStatusBar.tooltip = "Build the connected device";
  buildStatusBar.show();

  const flashStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99
  );
  flashStatusBar.text = "$(zap) Flash";
  flashStatusBar.command = "extension.flashCommand";
  flashStatusBar.tooltip = "Flash the connected device";
  flashStatusBar.show();

  const haltStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    98
  );
  haltStatusBar.text = "$(debug-pause) Halt";
  haltStatusBar.command = "extension.haltCommand";
  haltStatusBar.tooltip = "Halt the target processor";
  haltStatusBar.show();

  const resumeStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    97
  );
  resumeStatusBar.text = "$(debug-continue) Resume";
  resumeStatusBar.command = "extension.resumeCommand";
  resumeStatusBar.tooltip = "Resume the target processor";
  resumeStatusBar.show();

  const eraseStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    96
  );
  eraseStatusBar.text = "$(trash) Erase";
  eraseStatusBar.command = "extension.eraseCommand";
  eraseStatusBar.tooltip = "Erase flash memory";
  eraseStatusBar.show();

  connectStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    95
  );
  connectStatusBar.text = "$(plug) Connect";
  connectStatusBar.command = "extension.connectCommand";
  connectStatusBar.tooltip = "Connect to a serial port";
  connectStatusBar.show();

  // Debug control buttons
  const debugStartStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    94
  );
  debugStartStatusBar.text = "$(debug-start) Debug";
  debugStartStatusBar.command = "port11-debugger.debug.start";
  debugStartStatusBar.tooltip = "Start debug session";
  debugStartStatusBar.show();

  const debugStopStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    93
  );
  debugStopStatusBar.text = "$(debug-stop) Stop";
  debugStopStatusBar.command = "port11-debugger.debug.stop";
  debugStopStatusBar.tooltip = "Stop debug session";
  debugStopStatusBar.show();

  const debugStepOverStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    92
  );
  debugStepOverStatusBar.text = "$(debug-step-over) Step";
  debugStepOverStatusBar.command = "port11-debugger.debug.stepOver";
  debugStepOverStatusBar.tooltip = "Step over (next line)";
  debugStepOverStatusBar.show();

  context.subscriptions.push(
    buildStatusBar,
    flashStatusBar,
    haltStatusBar,
    resumeStatusBar,
    eraseStatusBar,
    connectStatusBar,
    debugStartStatusBar,
    debugStopStatusBar,
    debugStepOverStatusBar
  );

  // Initialize managers
  try {
    outputChannel.appendLine("Initializing core managers...");
    sdkManager = new SDKManager(context, outputChannel);
    outputChannel.appendLine("  SDK Manager initialized");

    toolchainManager = new ToolchainManager(context, outputChannel);
    outputChannel.appendLine("  Toolchain Manager initialized");

    sysConfigManager = new SysConfigManager(context, outputChannel);
    outputChannel.appendLine("  SysConfig Manager initialized");

    connectionManager = new ConnectionManager(context, outputChannel);
    outputChannel.appendLine("  Connection Manager initialized");

    outputChannel.appendLine("Initializing CLI Manager...");
    cliManager = new CliManager(context);
    try {
      await cliManager.initialize();
      outputChannel.appendLine(
        "  CLI Manager initialized and swd-debugger ready"
      );
    } catch (error) {
      outputChannel.appendLine(`  CLI Manager initialization failed: ${error}`);
      throw error;
    }

    outputChannel.appendLine("All managers initialized successfully");
    outputChannel.appendLine("");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Failed to initialize managers: ${errorMessage}`);
    outputChannel.show(true);
    vscode.window.showErrorMessage(
      `Port11 Debugger initialization failed: ${errorMessage}`
    );
    throw error;
  }

  // Initialize commands
  try {
    outputChannel.appendLine("Initializing command handlers...");
    const buildCommand = new BuildCommand(
      context,
      outputChannel,
      sdkManager,
      toolchainManager,
      sysConfigManager
    );
    const flashCommand = new FlashCommand(
      context,
      outputChannel,
      connectionManager
    );
    debugCommand = new DebugCommand(
      context,
      outputChannel,
      connectionManager,
      cliManager
    );
    outputChannel.appendLine("Command handlers initialized successfully");

    // Listen for breakpoint hits to update UI automatically
    debugCommand.onBreakpointHit(async () => {
      outputChannel.appendLine("Breakpoint hit - updating UI...");

      // Update registry data in DataViewProvider
      try {
        await dataViewProvider?.updateRegistryData();
      } catch (error) {
        outputChannel.appendLine(`Failed to update registry data: ${error}`);
      }

      // Update variables in DataViewProvider
      try {
        const variables = await debugCommand.getVariables();
        dataViewProvider?.updateVariables(
          variables.localVariables,
          variables.globalVariables,
          true
        );
      } catch (error) {
        outputChannel.appendLine(`Failed to update variables: ${error}`);
      }

      // Update call stack
      try {
        const callStack = await debugCommand.getCallStack();
        callStackViewProvider?.updateCallStack(callStack, true);
      } catch (error) {
        outputChannel.appendLine(`Failed to update call stack: ${error}`);
      }

      // Show arrow at current PC location
      try {
        const pc = await debugCommand.readPC();
        await showArrowAtPC(pc, outputChannel);
      } catch (error) {
        outputChannel.appendLine(`Failed to show arrow at PC: ${error}`);
      }
    });

    debugCommand.onStepCompleted(async (pcAddress: string | null) => {
      outputChannel.appendLine("Step completed - updating UI...");

      // Update registry data in DataViewProvider
      try {
        await dataViewProvider?.updateRegistryData();
      } catch (error) {
        outputChannel.appendLine(`Failed to update registry data: ${error}`);
      }

      // Update variables in DataViewProvider
      try {
        const variables = await debugCommand.getVariables();
        dataViewProvider?.updateVariables(
          variables.localVariables,
          variables.globalVariables,
          true
        );
      } catch (error) {
        outputChannel.appendLine(`Failed to update variables: ${error}`);
      }

      // Update call stack
      try {
        const callStack = await debugCommand.getCallStack();
        callStackViewProvider?.updateCallStack(callStack, true);
      } catch (error) {
        outputChannel.appendLine(`Failed to update call stack: ${error}`);
      }

      // Show arrow at current PC location (similar to resume)
      try {
        if (pcAddress) {
          await showArrowAtPC(pcAddress, outputChannel);
        } else {
          // Fallback: read PC if not provided in step output
          const pc = await debugCommand.readPC();
          await showArrowAtPC(pc, outputChannel);
        }
      } catch (error) {
        outputChannel.appendLine(`Failed to show arrow at PC: ${error}`);
      }
    });

    // Listen for halt events to update UI automatically (after resume halts)
    debugCommand.onHaltDetected(async () => {
      outputChannel.appendLine("Halt detected - updating UI...");

      // Update registry data in DataViewProvider
      try {
        await dataViewProvider?.updateRegistryData();
      } catch (error) {
        outputChannel.appendLine(`Failed to update registry data: ${error}`);
      }

      // Update variables in DataViewProvider
      try {
        const variables = await debugCommand.getVariables();
        dataViewProvider?.updateVariables(
          variables.localVariables,
          variables.globalVariables,
          true
        );
      } catch (error) {
        outputChannel.appendLine(`Failed to update variables: ${error}`);
      }

      // Update call stack
      try {
        const callStack = await debugCommand.getCallStack();
        callStackViewProvider?.updateCallStack(callStack, true);
      } catch (error) {
        outputChannel.appendLine(`Failed to update call stack: ${error}`);
      }

      // Show arrow at current PC location
      try {
        const pc = await debugCommand.readPC();
        await showArrowAtPC(pc, outputChannel);
      } catch (error) {
        outputChannel.appendLine(`Failed to show arrow at PC: ${error}`);
      }
    });

    // Initialize TreeView Provider
    try {
      outputChannel.appendLine("Initializing TreeView provider...");
      treeViewProvider = new Port11TreeViewProvider(context, outputChannel, {
        connectionManager,
        sdkManager,
        toolchainManager,
        sysConfigManager,
      });
      outputChannel.appendLine("  TreeView provider initialized successfully");
      outputChannel.appendLine("");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(
        `Failed to initialize TreeView provider: ${errorMessage}`
      );
      throw error;
    }

    // TreeView provider is initialized but not registered as a view
    // It's used for internal state management only

    // Initialize and Register Top Toolbar Provider
    outputChannel.appendLine("Initializing Top Toolbar...");
    topToolbarProvider = new TopToolbarProvider(context.extensionUri);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "port11.topToolbarView",
        topToolbarProvider
      )
    );
    outputChannel.appendLine("  Top Toolbar initialized successfully");

    // Initialize and Register Console View Provider
    outputChannel.appendLine("Initializing Console View...");
    consoleViewProvider = new ConsoleViewProvider(context.extensionUri);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "port11.consoleView",
        consoleViewProvider
      )
    );
    outputChannel.appendLine("  Console View initialized successfully");

    // Initialize and Register Call Stack View Provider
    outputChannel.appendLine("Initializing Call Stack View...");
    callStackViewProvider = new CallStackViewProvider(
      context.extensionUri,
      outputChannel
    );
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "port11.callStackView",
        callStackViewProvider
      )
    );
    outputChannel.appendLine("  Call Stack View initialized successfully");

    // Initialize and Register Data View Provider FIRST
    // (so we can pass it to BreakpointsViewProvider)
    outputChannel.appendLine("Initializing Data View...");
    const swdDebuggerPath = cliManager.getSanitizedExecutablePath();
    dataViewProvider = new DataViewProvider(
      context.extensionUri,
      outputChannel,
      swdDebuggerPath
    );
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "port11.dataView",
        dataViewProvider
      )
    );
    outputChannel.appendLine("  Data View initialized successfully");

    // Initialize and Register Breakpoints View Provider
    // (pass dataViewProvider reference for auto-refresh)
    outputChannel.appendLine("Initializing Breakpoints View...");
    breakpointsViewProvider = new BreakpointsViewProvider(
      context.extensionUri,
      outputChannel,
      swdDebuggerPath,
      dataViewProvider
    );
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "port11.variablesView",
        breakpointsViewProvider
      )
    );
    outputChannel.appendLine("  Breakpoints View initialized successfully");

    // Initialize and Register Boards View Provider
    outputChannel.appendLine("Initializing Boards View...");
    boardsViewProvider = new BoardsViewProvider(
      context.extensionUri,
      connectionManager,
      outputChannel
    );
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "port11.boardsView",
        boardsViewProvider
      )
    );
    outputChannel.appendLine("  Boards View initialized successfully");

    // Initialize and Register Setup View Provider
    outputChannel.appendLine("Initializing Setup View...");
    setupViewProvider = new SetupViewProvider(
      context.extensionUri,
      { sdkManager, toolchainManager, sysConfigManager },
      outputChannel
    );
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "port11.setupView",
        setupViewProvider
      )
    );
    outputChannel.appendLine("  Setup View initialized successfully");
    outputChannel.appendLine("");

    // Register all commands
    const commands = [
      // Setup and management commands
      vscode.commands.registerCommand("port11-debugger.setupToolchain", () =>
        setupToolchain()
      ),
      vscode.commands.registerCommand("port11-debugger.refreshStatus", () =>
        refreshStatus()
      ),
      vscode.commands.registerCommand("port11-debugger.refreshView", () =>
        treeViewProvider.refresh()
      ),
      vscode.commands.registerCommand("port11-debugger.openSettings", () =>
        openExtensionSettings()
      ),
      vscode.commands.registerCommand("port11-debugger.showLogs", () =>
        outputChannel.show()
      ),

      // Build commands
      vscode.commands.registerCommand("port11-debugger.build", () =>
        buildCommand.execute()
      ),
      vscode.commands.registerCommand("port11-debugger.clean", () =>
        buildCommand.execute({ clean: true })
      ),

      // Status bar build command
      vscode.commands.registerCommand("extension.buildCommand", () => {
        vscode.window.showInformationMessage("Build command triggered!");
        buildCommand.execute();
      }),

      // Flash commands
      vscode.commands.registerCommand("port11-debugger.flash", () =>
        flashCommand.execute()
      ),

      // Debug commands
      vscode.commands.registerCommand(
        "port11-debugger.debug.start",
        async (port?: string) => {
          await debugCommand.start(port);

          treeViewProvider.setDebugActive(true);
          breakpointsViewProvider?.setDebugActive(true); 
          
          // Show the top toolbar when debug starts
          topToolbarProvider?.show();

          // Load disassembly for address mapping in breakpoint view
          const workspaceFolder =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (workspaceFolder && breakpointsViewProvider) {
            await breakpointsViewProvider.loadDisassembly(workspaceFolder);
          }

          // Set breakpoint view as active
          try {
            breakpointsViewProvider?.setDebugActive(true);
          } catch (error) {
            outputChannel.appendLine(
              `Failed to activate breakpoint view: ${error}`
            );
          }

          // Update device breakpoints from hardware (optional in offline mode)
          try {
            const selectedPort = connectionManager.getSelectedPort();
            if (selectedPort && selectedPort !== "offline") {
              await breakpointsViewProvider?.updateDeviceBreakpoints();
            } else {
              outputChannel.appendLine(
                "Skipping device breakpoints in offline mode"
              );
            }
          } catch (error) {
            outputChannel.appendLine(
              `Failed to get device breakpoints (continuing anyway): ${error}`
            );
          }

          // IMPORTANT: Add a small delay and force refresh
          setTimeout(() => {
            outputChannel.appendLine(
              "Forcing final breakpoint view refresh..."
            );
            breakpointsViewProvider?.refresh();
          }, 500);
        }
      ),
      vscode.commands.registerCommand(
        "port11-debugger.debug.stop",
        async () => {
          await debugCommand.stop();
          treeViewProvider.setDebugActive(false);

          // Hide the top toolbar when debug stops
          topToolbarProvider?.hide();

          // Deactivate breakpoint view (ADDED)
          try {
            breakpointsViewProvider?.setDebugActive(false);
          } catch (error) {
            outputChannel.appendLine(
              `Failed to deactivate breakpoint view: ${error}`
            );
          }

          // Clear call stack view
          callStackViewProvider?.updateCallStack([], false);

          // Clear DataViewProvider
          dataViewProvider?.updateVariables([], [], false);
        }
      ),
      vscode.commands.registerCommand(
        "port11-debugger.debug.pause",
        async () => {
          await debugCommand.halt();

          // Update registry data in DataViewProvider when halted
          try {
            await dataViewProvider?.updateRegistryData();
          } catch (error) {
            outputChannel.appendLine(
              `Failed to update registry data: ${error}`
            );
          }

          // Update variables in DataViewProvider when paused
          try {
            const variables = await debugCommand.getVariables();
            dataViewProvider?.updateVariables(
              variables.localVariables,
              variables.globalVariables,
              true
            );
          } catch (error) {
            outputChannel.appendLine(`Failed to update variables: ${error}`);
          }

          // Update call stack when paused
          try {
            const callStack = await debugCommand.getCallStack();
            callStackViewProvider?.updateCallStack(callStack, true);
          } catch (error) {
            outputChannel.appendLine(`Failed to update call stack: ${error}`);
          }

          // Show arrow at current PC location
          try {
            const pc = await debugCommand.readPC();
            await showArrowAtPC(pc, outputChannel);
          } catch (error) {
            outputChannel.appendLine(`Failed to show arrow at PC: ${error}`);
          }
        }
      ),
      vscode.commands.registerCommand(
        "port11-debugger.debug.resume",
        async () => {
          try {
            await debugCommand.resume();

            // Clear call stack view when running
            callStackViewProvider?.updateCallStack([], false);

            // Clear variables in DataViewProvider when running
            dataViewProvider?.updateVariables([], [], false);

            outputChannel.appendLine(
              "Target resumed - monitoring for breakpoints..."
            );
          } catch (error) {
            outputChannel.appendLine(`Failed to resume: ${error}`);
            vscode.window.showErrorMessage(`Failed to resume target: ${error}`);
          }
        }
      ),

      // Debug stepping commands
      vscode.commands.registerCommand(
        "port11-debugger.debug.stepOver",
        async () => {
          try {
            await debugCommand.stepOver();

            // Update views after step
            try {
              await dataViewProvider?.updateRegistryData();
              const variables = await debugCommand.getVariables();
              dataViewProvider?.updateVariables(
                variables.localVariables,
                variables.globalVariables,
                true
              );
              const callStack = await debugCommand.getCallStack();
              callStackViewProvider?.updateCallStack(callStack, true);
            } catch (error) {
              outputChannel.appendLine(
                `Failed to update debug views: ${error}`
              );
            }

            // Update call stack
            try {
              const callStack = await debugCommand.getCallStack();
              callStackViewProvider?.updateCallStack(callStack, true);
            } catch (error) {
              outputChannel.appendLine(`Failed to update call stack: ${error}`);
            }

            // Show arrow at current PC location
            try {
              const pc = await debugCommand.readPC();
              await showArrowAtPC(pc, outputChannel);
            } catch (error) {
              outputChannel.appendLine(`Failed to show arrow at PC: ${error}`);
            }
          } catch (error) {
            outputChannel.appendLine(`Step Out failed: ${error}`);
            if (error instanceof Error && !error.message.includes("GDB")) {
              vscode.window.showErrorMessage(`Step Out failed: ${error}`);
            }
          }
        }
      ),
      vscode.commands.registerCommand(
        "port11-debugger.debug.stepInto",
        async () => {
          try {
            await debugCommand.stepInto();

            // Update views after step (same as stepOver)
            try {
              await dataViewProvider?.updateRegistryData();
              const callStack = await debugCommand.getCallStack();
              callStackViewProvider?.updateCallStack(callStack, true);
              const variables = await debugCommand.getVariables();
              breakpointsViewProvider?.updateBreakpoints(variables, true);
            } catch (error) {
              outputChannel.appendLine(
                `Failed to update debug views: ${error}`
              );
            }

            // Show arrow at current PC location
            try {
              const pc = await debugCommand.readPC();
              await showArrowAtPC(pc, outputChannel);
            } catch (error) {
              outputChannel.appendLine(`Failed to show arrow at PC: ${error}`);
            }
          } catch (error) {
            outputChannel.appendLine(`Step Into failed: ${error}`);
            if (
              error instanceof Error &&
              !error.message.includes("not supported")
            ) {
              vscode.window.showErrorMessage(`Step Into failed: ${error}`);
            }
          }
        }
      ),
      vscode.commands.registerCommand(
        "port11-debugger.debug.stepOut",
        async () => {
          try {
            await debugCommand.stepOut();

            // Update views after step
            try {
              await dataViewProvider?.updateRegistryData();
              const callStack = await debugCommand.getCallStack();
              callStackViewProvider?.updateCallStack(callStack, true);
              const variables = await debugCommand.getVariables();
              breakpointsViewProvider?.updateBreakpoints(variables, true);
            } catch (error) {
              outputChannel.appendLine(
                `Failed to update debug views: ${error}`
              );
            }

            // Show arrow at current PC location
            try {
              const pc = await debugCommand.readPC();
              await showArrowAtPC(pc, outputChannel);
            } catch (error) {
              outputChannel.appendLine(`Failed to show arrow at PC: ${error}`);
            }
          } catch (error) {
            outputChannel.appendLine(`Step Out failed: ${error}`);
            if (error instanceof Error && !error.message.includes("GDB")) {
              vscode.window.showErrorMessage(`Step Out failed: ${error}`);
            }
          }
        }
      ),

      // Board management commands
      vscode.commands.registerCommand(
        "port11-debugger.detectBoards",
        async () => {
          await detectBoards();
          treeViewProvider.refresh();
        }
      ),
    ];

    // Add all disposables to context
    context.subscriptions.push(outputChannel, statusBarItem, ...commands);

    outputChannel.appendLine(
      `Successfully registered ${commands.length} commands`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Failed to register commands: ${errorMessage}`);
    throw error;
  }

  // Initialize extension
  try {
    await initializeExtension();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(
      `Extension initialization failed: ${errorMessage}`
    );
    vscode.window.showErrorMessage(
      `Port11 Debugger initialization failed: ${errorMessage}`
    );
  }

  outputChannel.appendLine("Port11 Debugger extension activation completed");
}

export function deactivate() {
  outputChannel?.appendLine("Port11 Debugger extension deactivated");
  statusBarItem?.dispose();
  outputChannel?.dispose();
}

async function highlightBreakpointLine(
  debugCommand: DebugCommand,
  breakpointsViewProvider: BreakpointsViewProvider | undefined,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  try {
    // Read the Program Counter to get current execution address
    const pc = await debugCommand.readPC();
    outputChannel.appendLine(`Current PC: ${pc}`);

    if (!breakpointsViewProvider) {
      outputChannel.appendLine("Breakpoints view not available");
      return;
    }

    // Get the address mapper from breakpoints view
    const addressMapper = (breakpointsViewProvider as any).addressMapper;

    if (!addressMapper || !addressMapper.isLoaded()) {
      outputChannel.appendLine(
        "Address mapper not loaded - cannot map PC to source line"
      );
      return;
    }

    // Search through all mapped addresses to find matching PC
    // The addressMapper stores file:line -> address mappings
    // We need to reverse lookup: address -> file:line
    const breakpointAddresses = addressMapper.getBreakpointAddresses();

    for (const bp of breakpointAddresses) {
      // Check if this breakpoint's address matches our PC
      // Note: PC might have Thumb bit set, so compare without LSB
      const pcValue = parseInt(pc, 16);
      const bpAddress = parseInt(bp.address, 16);

      // Compare with and without Thumb bit (bit 0)
      if (pcValue === bpAddress || (pcValue & ~1) === (bpAddress & ~1)) {
        outputChannel.appendLine(
          `Found source location: ${bp.file}:${bp.line}`
        );

        // Navigate to the source location
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          outputChannel.appendLine("No workspace folder found");
          return;
        }

        // Resolve file path
        let fileUri: vscode.Uri;
        if (bp.file.startsWith("/") || bp.file.match(/^[a-zA-Z]:\\/)) {
          // Absolute path
          fileUri = vscode.Uri.file(bp.file);
        } else {
          // Relative path - join with workspace
          fileUri = vscode.Uri.joinPath(workspaceFolder.uri, bp.file);
        }

        // Open the document
        const document = await vscode.workspace.openTextDocument(fileUri);
        const line = bp.line - 1; // Convert to 0-based

        // Show the document with selection/highlight
        await vscode.window.showTextDocument(document, {
          selection: new vscode.Range(
            new vscode.Position(line, 0),
            new vscode.Position(line, 0)
          ),
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: false, // Give focus to the editor
        });

        // Create a decoration to highlight the line
        const decorationType = vscode.window.createTextEditorDecorationType({
          backgroundColor: new vscode.ThemeColor(
            "editor.stackFrameHighlightBackground"
          ),
          isWholeLine: true,
          overviewRulerColor: new vscode.ThemeColor(
            "debugIcon.breakpointForeground"
          ),
          overviewRulerLane: vscode.OverviewRulerLane.Full,
        });

        const editor = vscode.window.activeTextEditor;
        if (editor) {
          editor.setDecorations(decorationType, [
            new vscode.Range(
              new vscode.Position(line, 0),
              new vscode.Position(line, Number.MAX_VALUE)
            ),
          ]);

          // Clear decoration after 5 seconds
          setTimeout(() => {
            decorationType.dispose();
          }, 5000);
        }

        outputChannel.appendLine(`Highlighted line ${bp.line} in ${bp.file}`);
        return; // Found and highlighted, exit
      }
    }

    outputChannel.appendLine(`No source mapping found for PC: ${pc}`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Error highlighting breakpoint line: ${errorMsg}`);
    throw error;
  }
}

// Command implementations
async function setupToolchain(): Promise<void> {
  try {
    outputChannel.appendLine(
      "Starting complete toolchain setup (SDK + Toolchain + SysConfig)..."
    );
    updateStatusBar("Setting up toolchain...");

    // Refresh TreeView before setup
    treeViewProvider.refresh();

    // Show progress notification
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Port11 Setup",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Installing components..." });

        // Install SDK
        if (!(await sdkManager.isSDKInstalled())) {
          progress.report({ message: "Installing MSPM0 SDK..." });
          await sdkManager.installSDK();
        }

        // Install Toolchain
        if (!(await toolchainManager.isToolchainInstalled())) {
          progress.report({ message: "Installing ARM-CGT-CLANG..." });
          await toolchainManager.installToolchain();
        }

        // Install SysConfig
        if (!(await sysConfigManager.isSysConfigInstalled())) {
          progress.report({ message: "Installing TI SysConfig..." });
          await sysConfigManager.installSysConfig();
        }

        progress.report({ message: "Setup complete!" });
      }
    );

    outputChannel.appendLine("Complete toolchain setup completed successfully");
    updateStatusBar("Setup complete");

    // Refresh TreeView and Setup View after setup
    treeViewProvider.refresh();
    setupViewProvider?.refresh();

    vscode.window.showInformationMessage(
      "Port11 setup completed successfully!"
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Setup failed: ${errorMessage}`);
    updateStatusBar("Setup failed");
    vscode.window.showErrorMessage(
      `Port11 Debugger setup failed: ${errorMessage}`
    );
  }
}

async function refreshStatus(): Promise<void> {
  try {
    outputChannel.appendLine("Refreshing status...");
    updateStatusBar("Refreshing...");

    // Check all component statuses
    const sdkInstalled = await sdkManager.isSDKInstalled();
    const sdkVersion = await sdkManager.getSDKVersion();

    const toolchainInstalled = await toolchainManager.isToolchainInstalled();
    const toolchainInfo = await toolchainManager.getToolchainInfo();

    const sysConfigInstalled = await sysConfigManager.isSysConfigInstalled();
    const sysConfigInfo = await sysConfigManager.getSysConfigInfo();

    const boards = await connectionManager.detectBoards();

    outputChannel.appendLine(`Status refresh complete:`);
    outputChannel.appendLine(
      `  SDK: ${sdkInstalled ? `installed (${sdkVersion})` : "not installed"}`
    );
    outputChannel.appendLine(
      `  Toolchain: ${
        toolchainInstalled
          ? `installed (${toolchainInfo.version})`
          : "not installed"
      }`
    );
    outputChannel.appendLine(
      `  SysConfig: ${
        sysConfigInstalled
          ? `installed (${sysConfigInfo.version})`
          : "not installed"
      }`
    );
    outputChannel.appendLine(`  Boards: ${boards.length} detected`);

    updateStatusBar(
      sdkInstalled && toolchainInstalled ? "Ready" : "Setup required"
    );

    // Refresh TreeView and WebViews
    treeViewProvider.refresh();
    boardsViewProvider?.refresh();
    setupViewProvider?.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Status refresh failed: ${errorMessage}`);
  }
}

async function restartDebugSession(debugCommand: DebugCommand): Promise<void> {
  try {
    await debugCommand.stop();
    treeViewProvider.setDebugActive(false);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await debugCommand.start();
    treeViewProvider.setDebugActive(true);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      `Failed to restart debug session: ${errorMessage}`
    );
  }
}

async function detectBoards() {
  try {
    outputChannel.appendLine("Detecting boards...");
    const boards = await connectionManager.detectBoards();

    outputChannel.appendLine(`Found ${boards.length} board(s):`);
    boards.forEach((board: any, index: number) => {
      outputChannel.appendLine(
        `  ${index + 1}. ${board.friendlyName} (${board.path})`
      );
    });

    if (boards.length === 0) {
      vscode.window.showInformationMessage(
        "No MSPM0 boards detected. Please check connections and drivers."
      );
      updateStatusBar("No boards found");
    } else {
      vscode.window.showInformationMessage(
        `Found ${boards.length} MSPM0 board(s). Check output for details.`
      );
      updateStatusBar(`${boards.length} boards found`);
    }

    // Refresh boards view
    boardsViewProvider?.refresh();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Board detection failed: ${errorMessage}`);
    updateStatusBar("Detection failed");
    vscode.window.showErrorMessage(`Board detection failed: ${errorMessage}`);
  }
}

function openExtensionSettings(): void {
  outputChannel.appendLine("Opening Port11 Debugger settings...");
  vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "port11-debugger"
  );
}

function updateStatusBar(text: string): void {
  if (statusBarItem) {
    statusBarItem.text = `$(chip) Port11: ${text}`;
    statusBarItem.tooltip = "Port11 Debugger - Click to show panel";
    statusBarItem.show();
  }
}

function updateConnectStatusBar(): void {
  if (connectStatusBar) {
    const selectedPort = connectionManager.getSelectedPort();
    const selectedPortInfo = connectionManager.getSelectedPortInfo();

    if (selectedPort) {
      const deviceType =
        selectedPortInfo?.deviceType !== "Unknown" &&
        selectedPortInfo?.deviceType
          ? ` (${selectedPortInfo.deviceType})`
          : "";
      connectStatusBar.text = `$(plug) ${selectedPort}${deviceType}`;
      connectStatusBar.tooltip = `Connected to: ${connectionManager.getPortStatusText()}\nClick to change port`;
    } else {
      connectStatusBar.text = "$(plug) Connect";
      connectStatusBar.tooltip = "Connect to a serial port";
    }
  }
}

// Initialization functions

async function initializeExtension(): Promise<void> {
  outputChannel.appendLine("Starting extension initialization...");

  // Check if status bar should be enabled
  const enableStatusBar = vscode.workspace
    .getConfiguration("port11-debugger")
    .get("enableStatusBar", true);
  if (enableStatusBar) {
    updateStatusBar("Initializing...");
  }

  // Check for first-time setup
  await checkFirstTimeSetup();

  // Auto-detect boards if enabled
  const autoDetectBoards = vscode.workspace
    .getConfiguration("port11-debugger")
    .get("autoDetectBoards", true);
  if (autoDetectBoards) {
    try {
      await detectBoards();
    } catch (error) {
      outputChannel.appendLine(`Auto board detection failed: ${error}`);
    }
  }

  // Check for updates if enabled
  const checkForUpdates = vscode.workspace
    .getConfiguration("port11-debugger")
    .get("checkForUpdatesOnStartup", true);
  if (checkForUpdates) {
    checkForExtensionUpdates();
  }

  // Initial status refresh
  await refreshStatus();

  outputChannel.appendLine("Extension initialization completed");
}

async function checkFirstTimeSetup(): Promise<void> {
  try {
    // Check if all components are already installed
    const sdkInstalled = await sdkManager.isSDKInstalled();
    const toolchainInstalled = await toolchainManager.isToolchainInstalled();
    const sysConfigInstalled = await sysConfigManager.isSysConfigInstalled();

    if (!sdkInstalled || !toolchainInstalled || !sysConfigInstalled) {
      outputChannel.appendLine(
        "First-time setup detected - missing components:"
      );
      if (!sdkInstalled) {
        outputChannel.appendLine("  - MSPM0 SDK");
      }
      if (!toolchainInstalled) {
        outputChannel.appendLine("  - ARM-CGT-CLANG Toolchain");
      }
      if (!sysConfigInstalled) {
        outputChannel.appendLine("  - TI SysConfig");
      }

      const showWelcome = vscode.workspace
        .getConfiguration("port11-debugger")
        .get("showWelcomeOnStartup", true);

      if (showWelcome) {
        const missingComponents = [];
        if (!sdkInstalled) {
          missingComponents.push("SDK");
        }
        if (!toolchainInstalled) {
          missingComponents.push("Toolchain");
        }
        if (!sysConfigInstalled) {
          missingComponents.push("SysConfig");
        }

        const result = await vscode.window.showInformationMessage(
          `Port11 Debugger: Setup required for MSPM0 development.\nMissing: ${missingComponents.join(
            ", "
          )}. Would you like to set up now?`,
          { title: "Setup Now", isCloseAffordance: false },
          { title: "Setup Later", isCloseAffordance: false },
          { title: "Don't Show Again", isCloseAffordance: true }
        );

        if (result?.title === "Setup Now") {
          await setupToolchain();
        } else if (result?.title === "Don't Show Again") {
          await vscode.workspace
            .getConfiguration("port11-debugger")
            .update(
              "showWelcomeOnStartup",
              false,
              vscode.ConfigurationTarget.Global
            );
        }
      }
    } else {
      outputChannel.appendLine(
        "All components already installed, skipping first-time setup"
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`First-time setup check failed: ${errorMessage}`);
  }
}

function checkForExtensionUpdates(): void {
  // This is a placeholder for future update checking functionality
  outputChannel.appendLine(
    "Checking for extension updates... (not implemented yet)"
  );
}

// Context and state management

export function getManagers() {
  return {
    sdkManager,
    toolchainManager,
    sysConfigManager,
    connectionManager,
    outputChannel,
    statusBarItem,
  };
}

export function getTreeViewProvider(): Port11TreeViewProvider {
  return treeViewProvider;
}
