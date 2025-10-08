import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { ConnectionManager, BoardInfo } from '../managers/connectionManager';
import { PlatformUtils } from '../utils/platformUtils';
import { CallStackFrame } from '../types/callStack';
import { VariableInfo, VariablesData } from '../types/variable';

export interface DebugSession {
    id: string;
    board: BoardInfo;
    isActive: boolean;
    startTime: Date;
}

export interface RegisterInfo {
    name: string;
    value: string;
    description?: string;
}

export interface MemoryReadResult {
    address: string;
    data: string;
    size: number;
}

export class DebugCommand {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private connectionManager: ConnectionManager;
    private dapProcess: ChildProcess | null = null;
    private currentSession: DebugSession | null = null;
    private dapBinaryPath: string;

    constructor(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel,
        connectionManager: ConnectionManager
    ) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.connectionManager = connectionManager;
        this.dapBinaryPath = this.getDAPBinaryPath();
    }

    async start(port?: string): Promise<DebugSession> {
        try {
            if (this.currentSession?.isActive) {
                throw new Error('Debug session already active');
            }

            this.outputChannel.appendLine('='.repeat(50));
            this.outputChannel.appendLine('Starting debug session...');
            this.outputChannel.appendLine('='.repeat(50));

            // Validate prerequisites
            await this.validatePrerequisites();

            // Get target board
            const targetBoard = await this.getTargetBoard(port);
            if (!targetBoard) {
                throw new Error('No target board available for debugging');
            }

            // Ensure board is connected
            if (!this.connectionManager.isConnected(targetBoard.path)) {
                await this.connectionManager.connectToBoard(targetBoard.path);
            }

            // Create debug session
            const session: DebugSession = {
                id: `debug-${Date.now()}`,
                board: targetBoard,
                isActive: true,
                startTime: new Date()
            };

            this.currentSession = session;
            this.outputChannel.appendLine(`Debug session started: ${session.id}`);
            this.outputChannel.appendLine(`Target board: ${targetBoard.friendlyName}`);
            
            // Initialize DAP connection (placeholder for now)
            await this.initializeDAPConnection(targetBoard);

            return session;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Debug start failed: ${errorMessage}`);
            throw error;
        }
    }

    async stop(): Promise<void> {
        try {
            if (!this.currentSession?.isActive) {
                this.outputChannel.appendLine('No active debug session to stop');
                return;
            }

            this.outputChannel.appendLine('Stopping debug session...');

            // Stop DAP process
            if (this.dapProcess) {
                this.dapProcess.kill();
                this.dapProcess = null;
            }

            // Mark session as inactive
            if (this.currentSession) {
                this.currentSession.isActive = false;
                this.outputChannel.appendLine(`Debug session stopped: ${this.currentSession.id}`);
                this.currentSession = null;
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Error stopping debug session: ${errorMessage}`);
            throw error;
        }
    }

    async halt(): Promise<void> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        this.outputChannel.appendLine('Halting target...');
        await this.executeDAPCommand(['halt']);
    }

    async resume(): Promise<void> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        this.outputChannel.appendLine('Resuming target...');
        await this.executeDAPCommand(['resume']);
    }

    async readRegister(register: string): Promise<string> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        this.outputChannel.appendLine(`Reading register: ${register}`);
        const result = await this.executeDAPCommand(['read-reg', register]);
        return this.parseRegisterValue(result);
    }

    async readAllRegisters(): Promise<RegisterInfo[]> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        this.outputChannel.appendLine('Reading all registers...');
        const result = await this.executeDAPCommand(['read-all']);
        return this.parseAllRegisters(result);
    }

    async readMemory(address: string, size: number = 4): Promise<MemoryReadResult> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        this.outputChannel.appendLine(`Reading memory at ${address}, size: ${size}`);
        const result = await this.executeDAPCommand(['read', address]);
        
        return {
            address,
            data: result.trim(),
            size
        };
    }

    async writeMemory(address: string, value: string): Promise<void> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        this.outputChannel.appendLine(`Writing memory at ${address}: ${value}`);
        await this.executeDAPCommand(['write', address, value]);
    }

    async readPC(): Promise<string> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        this.outputChannel.appendLine('Reading Program Counter...');
        const result = await this.executeDAPCommand(['read-pc']);
        return this.parseRegisterValue(result);
    }

    getActiveSession(): DebugSession | null {
        return this.currentSession;
    }

    private async validatePrerequisites(): Promise<void> {
        // Check if DAP binary exists
        if (!fs.existsSync(this.dapBinaryPath)) {
            throw new Error(`DAP binary not found: ${this.dapBinaryPath}`);
        }

        // Check if there are any boards detected
        const boards = await this.connectionManager.detectBoards();
        if (boards.length === 0) {
            throw new Error('No boards detected. Please connect a board and try again.');
        }
    }

    private async getTargetBoard(preferredPort?: string): Promise<BoardInfo | null> {
        const boards = await this.connectionManager.detectBoards();

        if (preferredPort) {
            const board = boards.find(b => b.path === preferredPort);
            if (board) {
                return board;
            } else {
                this.outputChannel.appendLine(`Warning: Preferred port ${preferredPort} not found`);
            }
        }

        // Try to get connected MSPM0 board
        const mspm0Boards = await this.connectionManager.getConnectedMSPM0Boards();
        if (mspm0Boards.length > 0) {
            return mspm0Boards[0];
        }

        // Fall back to default board
        return await this.connectionManager.getDefaultBoard();
    }

    private async initializeDAPConnection(board: BoardInfo): Promise<void> {
        // TODO: Initialize the actual DAP connection
        // For now, this is a placeholder
        this.outputChannel.appendLine(`Initializing DAP connection to ${board.path}`);
        
        // Test DAP binary availability
        try {
            await this.executeDAPCommand(['--help']);
            this.outputChannel.appendLine('DAP CLI is available and responsive');
        } catch (error) {
            throw new Error(`DAP CLI initialization failed: ${error}`);
        }
    }

    private async executeDAPCommand(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.currentSession) {
                reject(new Error('No active debug session'));
                return;
            }

            const fullArgs = [
                '--port', this.currentSession.board.path,
                '--baud', '115200',
                ...args
            ];

            // Add verbose flag if configured
            const config = vscode.workspace.getConfiguration('port11-debugger');
            if (config.get('debugVerbose', false)) {
                fullArgs.push('--verbose');
            }

            this.outputChannel.appendLine(`Executing DAP command: ${this.dapBinaryPath} ${fullArgs.join(' ')}`);

            const dapProcess = spawn(this.dapBinaryPath, fullArgs, {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            dapProcess.stdout.on('data', (data) => {
                const output = data.toString();
                stdout += output;
                this.outputChannel.append(output);
            });

            dapProcess.stderr.on('data', (data) => {
                const output = data.toString();
                stderr += output;
                this.outputChannel.append(output);
            });

            dapProcess.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(new Error(`DAP command failed with exit code ${code}: ${stderr}`));
                }
            });

            dapProcess.on('error', (error) => {
                reject(new Error(`DAP process error: ${error.message}`));
            });

            // Set timeout for DAP commands
            setTimeout(() => {
                dapProcess.kill();
                reject(new Error('DAP command timed out'));
            }, 10000); // 10 second timeout
        });
    }

    private getDAPBinaryPath(): string {
        const platform = PlatformUtils.getCurrentPlatform();
        const executableName = platform.startsWith('win32') ? 'msp_dap_link_via_serial.exe' : 'msp_dap_link_via_serial';
        
        // TODO: Once we have the compiled binaries, they will be in:
        // return path.join(this.context.extensionPath, 'dist', 'bin', platform, executableName);
        
        // For now, return a placeholder path
        const placeholderPath = path.join(this.context.extensionPath, 'dist', 'bin', platform, executableName);
        this.outputChannel.appendLine(`DAP binary path (placeholder): ${placeholderPath}`);
        
        return placeholderPath;
    }

    private parseRegisterValue(output: string): string {
        // Parse the register value from DAP CLI output
        // Expected format: "Register value: 0x12345678" or similar
        const match = output.match(/(?:value|:)\s*(0x[0-9a-fA-F]+|\d+)/i);
        if (match) {
            return match[1];
        }
        
        // Return raw output if parsing fails
        return output.trim();
    }

    private parseAllRegisters(output: string): RegisterInfo[] {
        const registers: RegisterInfo[] = [];
        const lines = output.split('\n');

        for (const line of lines) {
            // Parse format: "R0: 0x12345678" or "PC: 0x08000000"
            const match = line.match(/([A-Z0-9]+):\s*(0x[0-9a-fA-F]+|\d+)/i);
            if (match) {
                registers.push({
                    name: match[1],
                    value: match[2],
                    description: this.getRegisterDescription(match[1])
                });
            }
        }

        return registers;
    }

    private getRegisterDescription(registerName: string): string {
        const descriptions: { [key: string]: string } = {
            'R0': 'General Purpose Register 0',
            'R1': 'General Purpose Register 1',
            'R2': 'General Purpose Register 2',
            'R3': 'General Purpose Register 3',
            'R4': 'General Purpose Register 4',
            'R5': 'General Purpose Register 5',
            'R6': 'General Purpose Register 6',
            'R7': 'General Purpose Register 7',
            'R8': 'General Purpose Register 8',
            'R9': 'General Purpose Register 9',
            'R10': 'General Purpose Register 10',
            'R11': 'General Purpose Register 11',
            'R12': 'General Purpose Register 12',
            'SP': 'Stack Pointer (R13)',
            'R13': 'Stack Pointer',
            'LR': 'Link Register (R14)',
            'R14': 'Link Register',
            'PC': 'Program Counter (R15)',
            'R15': 'Program Counter',
            'XPSR': 'Program Status Register',
            'PSR': 'Program Status Register'
        };

        return descriptions[registerName.toUpperCase()] || 'Unknown Register';
    }

    // Utility methods for debugging workflow

    async resetTarget(): Promise<void> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        this.outputChannel.appendLine('Resetting target...');
        // TODO: Implement reset command when available in DAP CLI
        await this.halt();
        // Reset would typically involve setting PC to reset vector
    }

    async stepInstruction(): Promise<void> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        this.outputChannel.appendLine('Stepping one instruction...');
        // TODO: Implement step command when available in DAP CLI
        await this.halt();
        // Step would involve single instruction execution
    }

    async setBreakpoint(address: string): Promise<void> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        this.outputChannel.appendLine(`Setting breakpoint at ${address}...`);
        // TODO: Implement breakpoint commands when available in DAP CLI
    }

    /**
     * Get the current call stack from the debugger
     * Returns an array of stack frames ordered from current (0) to oldest
     */
    async getCallStack(): Promise<CallStackFrame[]> {
        if (!this.currentSession?.isActive) {
            return [];
        }

        try {
            this.outputChannel.appendLine('Reading call stack...');

            // Execute DAP CLI command to get call stack
            // Expected command format: dap-cli --port <port> backtrace
            const result = await this.executeDAPCommand(['backtrace']);

            // Parse the call stack from DAP CLI output
            const frames = this.parseCallStack(result);

            this.outputChannel.appendLine(`Call stack retrieved: ${frames.length} frames`);
            return frames;

        } catch (error) {
            this.outputChannel.appendLine(`Failed to read call stack: ${error}`);
            return [];
        }
    }

    /**
     * Parse call stack output from DAP CLI
     * Expected format examples:
     * - "#0  0x08000234 in delay_ms () at src/main.c:123"
     * - "#1  0x08000100 in main () at src/main.c:89"
     * - "#2  0x08000000 in __start ()"
     */
    private parseCallStack(output: string): CallStackFrame[] {
        const frames: CallStackFrame[] = [];
        const lines = output.split('\n');

        for (const line of lines) {
            // Match GDB-style backtrace format:
            // #<index>  <address> in <function> (<args>) at <file>:<line>
            const match = line.match(/^#(\d+)\s+(?:0x[0-9a-fA-F]+\s+)?(?:in\s+)?(\S+)\s*\([^)]*\)(?:\s+at\s+([^:]+):(\d+))?/);

            if (match) {
                const index = parseInt(match[1]);
                const functionName = match[2];
                const filePath = match[3] || undefined;
                const lineNumber = match[4] ? parseInt(match[4]) : undefined;

                // Extract address if present
                const addressMatch = line.match(/0x[0-9a-fA-F]+/);
                const address = addressMatch ? addressMatch[0] : undefined;

                // Determine if it's external code (no file path)
                const isExternal = !filePath;

                frames.push({
                    index: index,
                    functionName: functionName,
                    filePath: filePath,
                    line: lineNumber,
                    address: address,
                    isExternal: isExternal,
                    isCurrent: index === 0, // Frame 0 is always current
                });
            } else {
                // Try simpler format: just function names
                const simpleMatch = line.match(/^#(\d+)\s+(.+)/);
                if (simpleMatch) {
                    frames.push({
                        index: parseInt(simpleMatch[1]),
                        functionName: simpleMatch[2].trim(),
                        isCurrent: parseInt(simpleMatch[1]) === 0,
                        isExternal: true,
                    });
                }
            }
        }

        return frames;
    }

    /**
     * Get all variables (local and global) from the debugger
     * Returns variables data grouped by scope
     */
    async getVariables(): Promise<VariablesData> {
        if (!this.currentSession?.isActive) {
            return {
                localVariables: [],
                globalVariables: [],
                totalCount: 0,
                isValid: false,
            };
        }

        try {
            this.outputChannel.appendLine('Reading variables...');

            // Execute DAP CLI commands to get local and global variables
            // Expected command format: dap-cli --port <port> info locals
            // Expected command format: dap-cli --port <port> info variables

            const localVarsOutput = await this.executeDAPCommand(['info', 'locals']);
            const globalVarsOutput = await this.executeDAPCommand(['info', 'variables']);

            // Parse the variables from DAP CLI output
            const localVariables = this.parseVariables(localVarsOutput, 'local');
            const globalVariables = this.parseVariables(globalVarsOutput, 'global');

            const totalCount = localVariables.length + globalVariables.length;

            this.outputChannel.appendLine(`Variables retrieved: ${localVariables.length} local, ${globalVariables.length} global`);

            return {
                localVariables,
                globalVariables,
                totalCount,
                isValid: true,
            };

        } catch (error) {
            this.outputChannel.appendLine(`Failed to read variables: ${error}`);
            return {
                localVariables: [],
                globalVariables: [],
                totalCount: 0,
                isValid: false,
            };
        }
    }

    /**
     * Parse variables output from DAP CLI
     * Expected format examples:
     * - "count = 0x5 at main.c:15"
     * - "delay_ms = 0x200000A4 at utils.c:8"
     * - "status = 0x1234 at main.c:20"
     * - "globalFlag = 0xABCD"
     * Also supports GDB-style format:
     * - "count = 5" (with address lookup needed)
     * - "ptr = 0x200000A4"
     */
    private parseVariables(output: string, defaultScope: 'local' | 'global'): VariableInfo[] {
        const variables: VariableInfo[] = [];
        const lines = output.split('\n');

        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }

            // Try to match: "varName = 0xADDR at file.c:line"
            let match = line.match(/^(\w+)\s*=\s*(0x[0-9a-fA-F]+)\s+at\s+([^:]+):(\d+)/i);

            if (match) {
                const varName = match[1];
                const address = this.normalizeAddress(match[2]);
                const filePath = match[3];
                const lineNumber = parseInt(match[4]);

                variables.push({
                    name: varName,
                    address: address,
                    line: lineNumber,
                    filePath: filePath,
                    scope: defaultScope,
                });
                continue;
            }

            // Try to match: "varName = 0xADDR"
            match = line.match(/^(\w+)\s*=\s*(0x[0-9a-fA-F]+)/i);

            if (match) {
                const varName = match[1];
                const address = this.normalizeAddress(match[2]);

                variables.push({
                    name: varName,
                    address: address,
                    scope: defaultScope,
                });
                continue;
            }

            // Try to match GDB format with type: "int count = 5" with separate address info
            match = line.match(/^(\w+)\s+(\w+)\s*=\s*(.+)/);

            if (match) {
                const varType = match[1];
                const varName = match[2];
                const varValue = match[3].trim();

                // Try to extract address if present
                const addrMatch = line.match(/0x[0-9a-fA-F]+/i);
                const address = addrMatch ? this.normalizeAddress(addrMatch[0]) : '0x0';

                variables.push({
                    name: varName,
                    address: address,
                    scope: defaultScope,
                    type: varType,
                    value: varValue,
                });
                continue;
            }

            // Simpler format: just "varName = value"
            match = line.match(/^(\w+)\s*=\s*(.+)/);

            if (match) {
                const varName = match[1];
                const varValue = match[2].trim();

                // Try to extract address if present in value
                const addrMatch = varValue.match(/0x[0-9a-fA-F]+/i);
                const address = addrMatch ? this.normalizeAddress(addrMatch[0]) : '0x0';

                variables.push({
                    name: varName,
                    address: address,
                    scope: defaultScope,
                    value: varValue,
                });
            }
        }

        return variables;
    }

    /**
     * Normalize memory address to format: 0xABCD (no leading zeros except prefix)
     */
    private normalizeAddress(address: string): string {
        // Remove 0x prefix, convert to uppercase, remove leading zeros, add 0x back
        const cleanAddr = address.replace(/^0x/i, '').toUpperCase();
        const noLeadingZeros = cleanAddr.replace(/^0+/, '') || '0';
        return '0x' + noLeadingZeros;
    }

    dispose(): void {
        if (this.dapProcess) {
            this.dapProcess.kill();
        }
        
        if (this.currentSession?.isActive) {
            this.currentSession.isActive = false;
        }
    }
}