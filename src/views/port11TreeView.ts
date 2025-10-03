import * as vscode from 'vscode';
import { ConnectionManager, BoardInfo } from '../managers/connectionManager';
import { SDKManager } from '../managers/sdkManager';
import { ToolchainManager } from '../managers/toolchainManager';
import { SysConfigManager } from '../managers/sysconfigManager';

export class Port11TreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue?: string,
        public readonly command?: vscode.Command,
        iconPath?: vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri }
    ) {
        super(label, collapsibleState);
        if (iconPath) {
            this.iconPath = iconPath;
        }
    }
}

export class Port11TreeViewProvider implements vscode.TreeDataProvider<Port11TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<Port11TreeItem | undefined | null | void> = new vscode.EventEmitter<Port11TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<Port11TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private connectionManager: ConnectionManager;
    private sdkManager: SDKManager;
    private toolchainManager: ToolchainManager;
    private sysConfigManager: SysConfigManager;

    // Debug state
    private debugActive: boolean = false;
    private registers: Map<string, string> = new Map();
    private callStack: string[] = [];
    private breakpoints: Map<string, number[]> = new Map();

    constructor(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel,
        managers: {
            connectionManager: ConnectionManager;
            sdkManager: SDKManager;
            toolchainManager: ToolchainManager;
            sysConfigManager: SysConfigManager;
        }
    ) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.connectionManager = managers.connectionManager;
        this.sdkManager = managers.sdkManager;
        this.toolchainManager = managers.toolchainManager;
        this.sysConfigManager = managers.sysConfigManager;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: Port11TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: Port11TreeItem): Promise<Port11TreeItem[]> {
        if (!element) {
            // Root level - show all sections
            return this.getRootSections();
        }

        // Get children for specific sections
        switch (element.contextValue) {
            case 'registers-section':
                return this.getRegisterItems();
            case 'breakpoints-section':
                return this.getBreakpointItems();
            case 'callstack-section':
                return this.getCallStackItems();
            case 'boards-section':
                return this.getBoardItems();
            case 'setup-section':
                return this.getSetupItems();
            default:
                return [];
        }
    }

    private async getRootSections(): Promise<Port11TreeItem[]> {
        const sections: Port11TreeItem[] = [];

        // Registers (only show when debugging)
        if (this.debugActive) {
            sections.push(new Port11TreeItem(
                'Registers',
                vscode.TreeItemCollapsibleState.Expanded,
                'registers-section',
                undefined,
                new vscode.ThemeIcon('symbol-variable')
            ));
        }

        // Breakpoints
        sections.push(new Port11TreeItem(
            'Breakpoints',
            vscode.TreeItemCollapsibleState.Collapsed,
            'breakpoints-section',
            undefined,
            new vscode.ThemeIcon('debug-breakpoint')
        ));

        // Call Stack (only show when debugging)
        if (this.debugActive) {
            sections.push(new Port11TreeItem(
                'Call Stack',
                vscode.TreeItemCollapsibleState.Expanded,
                'callstack-section',
                undefined,
                new vscode.ThemeIcon('debug-stackframe')
            ));
        }

        // Boards
        sections.push(new Port11TreeItem(
            'Boards',
            vscode.TreeItemCollapsibleState.Expanded,
            'boards-section',
            undefined,
            new vscode.ThemeIcon('device-mobile')
        ));

        // Setup Status
        sections.push(new Port11TreeItem(
            'Setup Status',
            vscode.TreeItemCollapsibleState.Collapsed,
            'setup-section',
            undefined,
            new vscode.ThemeIcon('gear')
        ));

        return sections;
    }

    private getRegisterItems(): Port11TreeItem[] {
        if (this.registers.size === 0) {
            return [new Port11TreeItem(
                'No debug session active',
                vscode.TreeItemCollapsibleState.None,
                'info',
                undefined,
                new vscode.ThemeIcon('info')
            )];
        }

        const items: Port11TreeItem[] = [];
        this.registers.forEach((value, name) => {
            items.push(new Port11TreeItem(
                `${name}: ${value}`,
                vscode.TreeItemCollapsibleState.None,
                'register',
                undefined,
                new vscode.ThemeIcon('symbol-numeric')
            ));
        });

        return items;
    }

    private getBreakpointItems(): Port11TreeItem[] {
        if (this.breakpoints.size === 0) {
            return [new Port11TreeItem(
                'No breakpoints set',
                vscode.TreeItemCollapsibleState.None,
                'info',
                {
                    command: 'workbench.debug.viewlet.action.addFunctionBreakpointAction',
                    title: 'Add Breakpoint'
                },
                new vscode.ThemeIcon('info')
            )];
        }

        const items: Port11TreeItem[] = [];
        this.breakpoints.forEach((lines, file) => {
            lines.forEach(line => {
                items.push(new Port11TreeItem(
                    `${file}:${line}`,
                    vscode.TreeItemCollapsibleState.None,
                    'breakpoint',
                    {
                        command: 'vscode.open',
                        title: 'Go to Breakpoint',
                        arguments: [vscode.Uri.file(file)]
                    },
                    new vscode.ThemeIcon('debug-breakpoint')
                ));
            });
        });

        return items;
    }

    private getCallStackItems(): Port11TreeItem[] {
        if (this.callStack.length === 0) {
            return [new Port11TreeItem(
                'No debug session active',
                vscode.TreeItemCollapsibleState.None,
                'info',
                undefined,
                new vscode.ThemeIcon('info')
            )];
        }

        return this.callStack.map((frame, index) => {
            return new Port11TreeItem(
                `#${index}: ${frame}`,
                vscode.TreeItemCollapsibleState.None,
                'stackframe',
                undefined,
                new vscode.ThemeIcon('debug-stackframe')
            );
        });
    }

    private async getBoardItems(): Promise<Port11TreeItem[]> {
        try {
            const boards = await this.connectionManager.detectBoards();

            if (boards.length === 0) {
                const detectItem = new Port11TreeItem(
                    'No boards detected',
                    vscode.TreeItemCollapsibleState.None,
                    'no-boards',
                    {
                        command: 'port11-debugger.detectBoards',
                        title: 'Detect Boards'
                    },
                    new vscode.ThemeIcon('search')
                );
                detectItem.description = 'Click to scan';
                return [detectItem];
            }

            return boards.map(board => {
                const item = new Port11TreeItem(
                    board.friendlyName || board.path,
                    vscode.TreeItemCollapsibleState.None,
                    board.isConnected ? 'board-connected' : 'board-disconnected',
                    undefined,
                    new vscode.ThemeIcon(
                        board.isConnected ? 'plug' : 'circle-outline',
                        board.isConnected ? new vscode.ThemeColor('charts.green') : undefined
                    )
                );
                item.description = board.path;
                item.tooltip = this.getBoardTooltip(board);
                return item;
            });
        } catch (error) {
            return [new Port11TreeItem(
                'Error detecting boards',
                vscode.TreeItemCollapsibleState.None,
                'error',
                undefined,
                new vscode.ThemeIcon('error')
            )];
        }
    }

    private async getSetupItems(): Promise<Port11TreeItem[]> {
        const items: Port11TreeItem[] = [];

        // SDK Status
        const sdkInstalled = await this.sdkManager.isSDKInstalled();
        items.push(this.createSetupItem(
            'MSPM0 SDK',
            sdkInstalled,
            'sdk'
        ));

        // Toolchain Status
        const toolchainInstalled = await this.toolchainManager.isToolchainInstalled();
        items.push(this.createSetupItem(
            'ARM-CGT-CLANG',
            toolchainInstalled,
            'toolchain'
        ));

        // SysConfig Status
        const sysConfigInstalled = await this.sysConfigManager.isSysConfigInstalled();
        items.push(this.createSetupItem(
            'TI SysConfig',
            sysConfigInstalled,
            'sysconfig'
        ));

        // SWD Debugger Status (always installed if extension is running)
        items.push(this.createSetupItem(
            'SWD Debugger',
            true,
            'debugger'
        ));

        // Setup button
        const allInstalled = sdkInstalled && toolchainInstalled && sysConfigInstalled;
        if (!allInstalled) {
            const setupItem = new Port11TreeItem(
                'Run Complete Setup',
                vscode.TreeItemCollapsibleState.None,
                'setup-action',
                {
                    command: 'port11-debugger.setupToolchain',
                    title: 'Run Setup'
                },
                new vscode.ThemeIcon('tools')
            );
            setupItem.description = 'Click to install';
            items.push(setupItem);
        }

        return items;
    }

    private createSetupItem(label: string, installed: boolean, contextValue: string): Port11TreeItem {
        const item = new Port11TreeItem(
            label,
            vscode.TreeItemCollapsibleState.None,
            `setup-${contextValue}`,
            undefined,
            new vscode.ThemeIcon(
                installed ? 'check' : 'circle-outline',
                installed ? new vscode.ThemeColor('charts.green') : new vscode.ThemeColor('charts.red')
            )
        );
        item.description = installed ? 'Installed' : 'Not installed';
        return item;
    }

    private getBoardTooltip(board: BoardInfo): string {
        const lines = [
            `Path: ${board.path}`,
            board.manufacturer && `Manufacturer: ${board.manufacturer}`,
            board.vendorId && board.productId && `VID:PID: ${board.vendorId}:${board.productId}`,
            board.serialNumber && `Serial: ${board.serialNumber}`,
            `Status: ${board.isConnected ? 'Connected' : 'Not connected'}`
        ].filter(Boolean);
        
        return lines.join('\n');
    }

    // Public methods to update debug state

    public setDebugActive(active: boolean): void {
        this.debugActive = active;
        if (!active) {
            this.registers.clear();
            this.callStack = [];
        }
        this.refresh();
    }

    public updateRegisters(registers: Map<string, string>): void {
        this.registers = registers;
        this.refresh();
    }

    public updateCallStack(stack: string[]): void {
        this.callStack = stack;
        this.refresh();
    }

    public updateBreakpoints(breakpoints: Map<string, number[]>): void {
        this.breakpoints = breakpoints;
        this.refresh();
    }
}