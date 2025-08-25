import * as vscode from 'vscode';
import { WebviewProvider } from './webview/webviewProvider';
import { SDKManager } from './managers/sdkManager';
import { ToolchainManager } from './managers/toolchainManager';
import { SerialManager } from './managers/serialManager';
import { BuildCommand } from './commands/buildCommand';
import { FlashCommand } from './commands/flashCommand';
import { DebugCommand } from './commands/debugCommand';

let outputChannel: vscode.OutputChannel;
let webviewProvider: WebviewProvider;
let sdkManager: SDKManager;
let toolchainManager: ToolchainManager;
let serialManager: SerialManager;

export async function activate(context: vscode.ExtensionContext) {
    // Initialize output channel for logging
    outputChannel = vscode.window.createOutputChannel('Port11 Debugger');
    outputChannel.show();
    outputChannel.appendLine('Port11 Debugger extension activated');

    // Initialize managers
    sdkManager = new SDKManager(context, outputChannel);
    toolchainManager = new ToolchainManager(context, outputChannel);
    serialManager = new SerialManager(outputChannel);
    
    // Initialize webview provider
    webviewProvider = new WebviewProvider(context, outputChannel, {
        sdkManager,
        toolchainManager,
        serialManager
    });

    // Initialize commands
    const buildCommand = new BuildCommand(context, outputChannel, sdkManager, toolchainManager);
    const flashCommand = new FlashCommand(context, outputChannel, serialManager);
    const debugCommand = new DebugCommand(context, outputChannel, serialManager);

    // Register commands
    const commands = [
        vscode.commands.registerCommand('port11-debugger.build', () => buildCommand.execute()),
        vscode.commands.registerCommand('port11-debugger.flash', () => flashCommand.execute()),
        vscode.commands.registerCommand('port11-debugger.debug.start', () => debugCommand.start()),
        vscode.commands.registerCommand('port11-debugger.debug.stop', () => debugCommand.stop()),
        vscode.commands.registerCommand('port11-debugger.showPanel', () => webviewProvider.show()),
        vscode.commands.registerCommand('port11-debugger.setup', () => setupToolchain()),
    ];

    // Register webview provider
    const webviewDisposable = vscode.window.registerWebviewViewProvider(
        'port11-debugger.mainView',
        webviewProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
    );

    // Add all disposables to context
    context.subscriptions.push(
        outputChannel,
        webviewDisposable,
        ...commands
    );

    // Check for first-time setup
    await checkFirstTimeSetup();
}

export function deactivate() {
    outputChannel?.appendLine('Port11 Debugger extension deactivated');
    outputChannel?.dispose();
}

async function setupToolchain(): Promise<void> {
    try {
        outputChannel.appendLine('Starting toolchain setup...');
        webviewProvider.show();
        
        // Start setup process
        await webviewProvider.startSetup();
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Setup failed: ${errorMessage}`);
        vscode.window.showErrorMessage(`Setup failed: ${errorMessage}`);
    }
}

async function checkFirstTimeSetup(): Promise<void> {
    const hasSetup = vscode.workspace.getConfiguration('port11-debugger').get('setupComplete', false);
    
    if (!hasSetup) {
        outputChannel.appendLine('First-time setup detected');
        
        const result = await vscode.window.showInformationMessage(
            'Port11 Debugger: First-time setup required. Would you like to set up the toolchain now?',
            'Setup Now',
            'Later'
        );
        
        if (result === 'Setup Now') {
            await setupToolchain();
        }
    }
}

// Export managers for use in other modules
export function getManagers() {
    return {
        sdkManager,
        toolchainManager,
        serialManager,
        outputChannel
    };
}