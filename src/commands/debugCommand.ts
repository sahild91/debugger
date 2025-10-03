import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { ConnectionManager, BoardInfo } from '../managers/connectionManager';
import { PlatformUtils } from '../utils/platformUtils';

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

    dispose(): void {
        if (this.dapProcess) {
            this.dapProcess.kill();
        }
        
        if (this.currentSession?.isActive) {
            this.currentSession.isActive = false;
        }
    }
}