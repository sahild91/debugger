import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { ConnectionManager, BoardInfo } from '../managers/connectionManager';
import { CliManager } from '../managers/cliManager';
import { CallStackFrame } from '../types/callStack';
import { VariableInfo, VariablesData } from '../types/variable';
import { SymbolParser } from '../utils/symbolParser';
import { EventEmitter } from 'events';

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
    private cliManager: CliManager;
    private dapProcess: ChildProcess | null = null;
    private currentSession: DebugSession | null = null;
    private monitorProcess: ChildProcess | null = null;
    private isMonitoring: boolean = false;
    private eventEmitter: EventEmitter = new EventEmitter();
    private disconnectCheckInterval: NodeJS.Timeout | null = null;

    constructor(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel,
        connectionManager: ConnectionManager,
        cliManager: CliManager
    ) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.connectionManager = connectionManager;
        this.cliManager = cliManager;
        this.connectionManager.onPortDisconnected((port) => {
        if (this.currentSession?.board.path === port) {
            this.outputChannel.appendLine(`Debug device ${port} was disconnected!`);
            this.handleDeviceDisconnect();
        }
    });
    }

    public onBreakpointHit(callback: () => void): void {
        this.eventEmitter.on('breakpointHit', callback);
    }

    /**
     * Start monitoring for device disconnection
     */
    private startDisconnectMonitoring(): void {
        // Clear any existing interval
        if (this.disconnectCheckInterval) {
            clearInterval(this.disconnectCheckInterval);
        }

        // Check every 2 seconds if the device is still connected
        this.disconnectCheckInterval = setInterval(async () => {
            if (!this.currentSession?.isActive) {
                return;
            }

            try {
                const boards = await this.connectionManager.detectBoards();
                const currentPort = this.currentSession.board.path;
                const stillConnected = boards.some(board => board.path === currentPort);

                if (!stillConnected) {
                    this.outputChannel.appendLine(`WARNING: Device at ${currentPort} was disconnected!`);
                    await this.handleDeviceDisconnect();
                }
            } catch (error) {
                // Ignore errors during disconnect check
            }
        }, 5000);  // Check every 2 seconds
    }

    /**
     * Stop monitoring for device disconnection
     */
    private stopDisconnectMonitoring(): void {
        if (this.disconnectCheckInterval) {
            clearInterval(this.disconnectCheckInterval);
            this.disconnectCheckInterval = null;
        }
    }

    /**
     * Handle device disconnection
     */
    private async handleDeviceDisconnect(): Promise<void> {
        this.outputChannel.appendLine('Handling device disconnection...');

        // Stop disconnect monitoring to avoid recursive calls
        this.stopDisconnectMonitoring();

        // Stop monitoring process if running
        if (this.isMonitoring) {
            this.outputChannel.appendLine('Killing monitoring process due to device disconnect...');
            this.forceStopMonitoring();
        }

        // Kill any DAP process
        if (this.dapProcess) {
            this.outputChannel.appendLine('Killing DAP process due to device disconnect...');
            this.dapProcess.kill('SIGKILL');
            this.dapProcess = null;
        }

        // Mark session as inactive
        if (this.currentSession) {
            this.currentSession.isActive = false;
            this.outputChannel.appendLine(`Debug session terminated: ${this.currentSession.id}`);
        }

        // Notify user
        vscode.window.showErrorMessage(
            'Debug device was disconnected. Debug session terminated.',
            'OK'
        );

        // Emit event so UI can update
        this.eventEmitter.emit('deviceDisconnected');
    }

    /**
     * Force stop monitoring immediately (for disconnect scenarios)
     */
    private forceStopMonitoring(): void {
        if (!this.monitorProcess) {
            return;
        }

        this.outputChannel.appendLine('Force stopping monitor process...');

        try {
            // Kill immediately with SIGKILL
            this.monitorProcess.kill('SIGKILL');
        } catch (error) {
            this.outputChannel.appendLine(`Error force stopping monitor: ${error}`);
        } finally {
            this.isMonitoring = false;
            this.monitorProcess = null;
        }
    }

    async start(port?: string): Promise<DebugSession> {
        try {
            if (this.currentSession?.isActive) {
                throw new Error('Debug session already active');
            }

            this.outputChannel.appendLine('='.repeat(50));
            this.outputChannel.appendLine('Starting debug session...');
            this.outputChannel.appendLine('='.repeat(50));

            // Get target board (if available)
            const targetBoard = await this.getTargetBoard(port);

            // Check if board is available
            const boardAvailable = targetBoard !== null;

            // Check if offline debugging is allowed
            const config = vscode.workspace.getConfiguration('port11-debugger');
            const allowDebugWithoutBoard = config.get('allowDebugWithoutBoard', true);

            // If no board available and offline mode not allowed, throw error
            if (!boardAvailable && !allowDebugWithoutBoard) {
                throw new Error('No board detected. Enable "allowDebugWithoutBoard" setting to debug without hardware.');
            }

            // Validate prerequisites - board is optional if allowDebugWithoutBoard is true
            await this.validatePrerequisites(boardAvailable);

            if (boardAvailable && targetBoard) {
                this.outputChannel.appendLine(`Target board detected: ${targetBoard.friendlyName}`);

                // Ensure board is connected
                if (!this.connectionManager.isConnected(targetBoard.path)) {
                    await this.connectionManager.connectToBoard(targetBoard.path);
                }

                // Create debug session with board
                const session: DebugSession = {
                    id: `debug-${Date.now()}`,
                    board: targetBoard,
                    isActive: true,
                    startTime: new Date()
                };

                this.currentSession = session;
                this.outputChannel.appendLine(`Debug session started: ${session.id}`);
                this.outputChannel.appendLine(`Target board: ${targetBoard.friendlyName}`);

                // Initialize DAP connection
                await this.initializeDAPConnection(targetBoard);

                // Halt the target to prepare for debugging
                this.outputChannel.appendLine('Halting target for inspection...');
                await this.halt();
                this.startDisconnectMonitoring();

                return session;
            } else {
                // Start debug session without board (simulation/offline mode)
                this.outputChannel.appendLine('No board detected - starting debug in offline mode');
                this.outputChannel.appendLine('Debug features will be limited without hardware connection');

                // Create a mock board info for offline mode
                const mockBoard: BoardInfo = {
                    path: 'offline',
                    friendlyName: 'Offline Debug Mode',
                    manufacturer: 'N/A',
                    serialNumber: 'N/A',
                    deviceType: 'Unknown',
                    isConnected: false
                };

                const session: DebugSession = {
                    id: `debug-offline-${Date.now()}`,
                    board: mockBoard,
                    isActive: true,
                    startTime: new Date()
                };

                this.currentSession = session;
                this.outputChannel.appendLine(`Debug session started in offline mode: ${session.id}`);
                this.outputChannel.appendLine('Debug views are available for symbol inspection');

                return session;
            }

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

            // Stop monitoring if active
            if (this.isMonitoring) {
                this.stopMonitoring();
            }

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

            this.stopDisconnectMonitoring();

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Error stopping debug session: ${errorMessage}`);
            throw error;
        }
    }

    public onDeviceDisconnected(callback: () => void): void {
        this.eventEmitter.on('deviceDisconnected', callback);
    }

    async halt(): Promise<void> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        // Check if in offline mode
        if (this.currentSession.board.path === 'offline') {
            this.outputChannel.appendLine('Halt command not available in offline mode');
            return;
        }

        this.outputChannel.appendLine('Halting target...');

        try {
            // CRITICAL: Stop the monitoring process first before sending halt
            if (this.isMonitoring) {
                this.outputChannel.appendLine('Stopping monitor process before halt...');
                this.stopMonitoring();

                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Now send the halt command
            await this.executeDAPCommand(['halt']);
            this.outputChannel.appendLine('Target halted successfully');

            // AUTO-READ registers after halt
            this.outputChannel.appendLine('Automatically reading registers...');
            await this.readAllRegisters();

            // Emit event so extension.ts can update variables and UI
            this.eventEmitter.emit('haltDetected');

        } catch (error) {
            this.outputChannel.appendLine(`Failed to halt: ${error}`);
            throw error;
        }
    }

    private startResumeWithMonitoring(): void {
        // If already monitoring, stop it first
        if (this.monitorProcess) {
            this.forceStopMonitoring();
        }

        const config = vscode.workspace.getConfiguration('port11-debugger');
        const cliPath = this.cliManager.getExecutablePath();
        const board = this.currentSession?.board;

        if (!board || !cliPath) {
            this.outputChannel.appendLine('ERROR: No board connected or CLI not available');
            return;
        }

        const args = ['--port', board.path, 'resume'];

        this.outputChannel.appendLine(`Executing: ${cliPath} ${args.join(' ')}`);

        // Spawn the resume process which will monitor until halt
        this.monitorProcess = spawn(cliPath, args, {
            stdio: ['pipe', 'pipe', 'pipe']
        });
        this.isMonitoring = true;

        let stdout = '';
        let stderr = '';
        let consecutiveErrors = 0;  // ✅ Track consecutive errors

        this.monitorProcess.stdout?.on('data', (data) => {
            const output = data.toString();
            stdout += output;
            this.outputChannel.append(output);

            // Check if breakpoint was hit
            if (this.checkForBreakpointHit(output)) {
                this.handleBreakpointHit();
            }
        });

        this.monitorProcess.stderr?.on('data', (data) => {
            const output = data.toString();
            stderr += output;

            // ✅ Check for disconnect-related errors
            if (this.isDisconnectError(output)) {
                consecutiveErrors++;

                if (consecutiveErrors >= 5) {  // 5 consecutive errors = likely disconnected
                    this.outputChannel.appendLine('Multiple consecutive errors detected - device may be disconnected');
                    this.handleDeviceDisconnect();
                    return;
                }
            } else {
                consecutiveErrors = 0;  // Reset counter on success
            }

            // Filter out transient monitor errors to reduce noise
            if (!output.includes('Monitor sample failed')) {
                this.outputChannel.append(output);
            }
        });

        this.monitorProcess.on('close', (code) => {
            this.outputChannel.appendLine(`Monitor process ended with code ${code}`);
            this.isMonitoring = false;
            this.monitorProcess = null;

            // ✅ Check if close was due to disconnect
            if (code && code !== 0 && stderr.includes('Failed to connect')) {
                this.outputChannel.appendLine('Monitor process closed due to connection failure');
                this.handleDeviceDisconnect();
            }
        });

        this.monitorProcess.on('error', (error) => {
            this.outputChannel.appendLine(`Monitor process error: ${error.message}`);
            this.isMonitoring = false;
            this.monitorProcess = null;

            // ✅ Check if error is disconnect-related
            if (this.isDisconnectError(error.message)) {
                this.handleDeviceDisconnect();
            }
        });
    }

    private isDisconnectError(errorMessage: string): boolean {
        const disconnectPatterns = [
            'Failed to connect',
            'Access is denied',
            'No such file or directory',
            'Device not found',
            'Port not found',
            'Connection refused',
            'Permission denied',
            'device does not recognize the command',
            'Invalid handle',
            'The system cannot find the file specified'
        ];

        const lowerError = errorMessage.toLowerCase();
        return disconnectPatterns.some(pattern =>
            lowerError.includes(pattern.toLowerCase())
        );
    }

    private checkForBreakpointHit(output: string): boolean {
        // Check for patterns indicating target halted
        // Based on the Rust code: "Target halted after X.XXXs – stopping monitor"
        return output.includes('Target halted') ||
            output.includes('HALTED') ||
            output.includes('stopping monitor');
    }

    private async handleBreakpointHit(): Promise<void> {
        this.outputChannel.appendLine('Breakpoint hit detected!');

        // Auto-read all registers when breakpoint is reached
        try {
            this.outputChannel.appendLine('Automatically reading registers...');
            await this.readAllRegisters();

            // Emit event so extension.ts can update UI and highlight line
            this.eventEmitter.emit('breakpointHit');
        } catch (error) {
            this.outputChannel.appendLine(`Failed to auto-read registers: ${error}`);
        }
    }

    public onHaltDetected(callback: () => void): void {
        this.eventEmitter.on('haltDetected', callback);
    }

    private stopMonitoring(): void {  // ✅ Changed from async to synchronous
        if (!this.monitorProcess || !this.isMonitoring) {
            this.outputChannel.appendLine('No monitoring process to stop');
            return;
        }

        this.outputChannel.appendLine('Stopping monitor process...');

        try {
            // Try graceful shutdown first
            this.monitorProcess.kill('SIGTERM');

            // Set up a timeout to force kill if needed
            const forceKillTimeout = setTimeout(() => {
                if (this.monitorProcess) {
                    this.outputChannel.appendLine('Monitor process did not stop gracefully, force killing...');
                    this.monitorProcess.kill('SIGKILL');
                }
            }, 500);  // 500ms timeout

            // Clean up when process actually exits
            this.monitorProcess.once('exit', () => {
                clearTimeout(forceKillTimeout);
                this.outputChannel.appendLine('Monitor process stopped');
            });

        } catch (error) {
            this.outputChannel.appendLine(`Error stopping monitor: ${error}`);
        } finally {
            // Always reset the flags immediately
            this.isMonitoring = false;
            this.monitorProcess = null;
        }
    }

    async resume(): Promise<void> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        // Check if in offline mode
        if (this.currentSession.board.path === 'offline') {
            this.outputChannel.appendLine('Resume command not available in offline mode');
            return;
        }

        this.outputChannel.appendLine('Resuming target...');

        try {
            // Start the resume command which includes built-in monitoring
            this.startResumeWithMonitoring();
            this.outputChannel.appendLine('Target resumed successfully - monitoring for breakpoints...');
        } catch (error) {
            this.outputChannel.appendLine(`Failed to resume: ${error}`);
            throw error;
        }
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

        // Check if in offline mode
        if (this.currentSession.board.path === 'offline') {
            // Return placeholder data in offline mode
            return {
                address,
                data: '0x00000000',
                size
            };
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

    private async validatePrerequisites(requireBoard: boolean = true): Promise<void> {
        // Check if swd-debugger CLI is available
        if (!this.cliManager.isCliAvailable()) {
            throw new Error('swd-debugger CLI not available. Please check installation.');
        }

        // Check if there are any boards detected (optional)
        if (requireBoard) {
            const boards = await this.connectionManager.detectBoards();
            if (boards.length === 0) {
                throw new Error('No boards detected. Please connect a board and try again.');
            }
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
        this.outputChannel.appendLine(`Initializing debug connection to ${board.path}`);

        // Test swd-debugger CLI availability
        try {
            await this.executeDAPCommand(['--version']);
            this.outputChannel.appendLine('swd-debugger CLI is available and responsive');
        } catch (error) {
            // --version might not exist, try without it
            this.outputChannel.appendLine('swd-debugger CLI initialized (version check skipped)');
        }
    }

    private async executeDAPCommand(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.currentSession) {
                reject(new Error('No active debug session'));
                return;
            }

            const swdDebuggerPath = this.cliManager.getSanitizedExecutablePath();

            const fullArgs = [
                '--port', this.currentSession.board.path,
                ...args
            ];

            // Add verbose flag if configured
            const config = vscode.workspace.getConfiguration('port11-debugger');
            if (config.get('debugVerbose', false)) {
                fullArgs.push('--verbose');
            }

            this.outputChannel.appendLine(`Executing debug command: ${swdDebuggerPath} ${fullArgs.join(' ')}`);

            const dapProcess = spawn(swdDebuggerPath, fullArgs, {
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
                reject(new Error(`Debug process error: ${error.message}`));
            });

            // Set timeout for debug commands
            const timeout = config.get('debugTimeout', 10000);
            setTimeout(() => {
                dapProcess.kill();
                reject(new Error('Debug command timed out'));
            }, timeout);
        });
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

    async stepOver(): Promise<void> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        // Check if in offline mode
        if (this.currentSession.board.path === 'offline') {
            this.outputChannel.appendLine('Step command not available in offline mode');
            return;
        }

        this.outputChannel.appendLine('Stepping one instruction...');

        try {
            // Execute the step command
            await this.executeDAPCommand(['step']);
            this.outputChannel.appendLine('Step completed');

            // AUTO-READ registers after step
            this.outputChannel.appendLine('Automatically reading registers...');
            await this.readAllRegisters();

            // Emit event to update UI and highlight the new line
            this.eventEmitter.emit('stepCompleted');

        } catch (error) {
            this.outputChannel.appendLine(`Failed to step: ${error}`);
            throw error;
        }
    }

    async stepInto(): Promise<void> {
        // For single instruction stepping, stepInto is the same as stepOver
        await this.stepOver();
    }

    async stepOut(): Promise<void> {
        if (!this.currentSession?.isActive) {
            throw new Error('No active debug session');
        }

        this.outputChannel.appendLine('Step Out not supported by DAP CLI yet');
        this.outputChannel.appendLine('This requires call stack unwinding which needs GDB integration');
        throw new Error('Step Out command requires GDB/LLDB integration');
    }

    public onStepCompleted(callback: () => void): void {
        this.eventEmitter.on('stepCompleted', callback);
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
            this.outputChannel.appendLine('Note: Call stack feature requires GDB/LLDB integration (not yet implemented)');

            // TODO: Call stack requires:
            // 1. Read SP (Stack Pointer) register
            // 2. Read LR (Link Register) for return addresses
            // 3. Unwind stack frames
            // 4. Match addresses to symbols from ELF file
            //
            // For now, return empty - this needs GDB protocol or DWARF parsing

            return [];

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
            this.outputChannel.appendLine('Reading variables from debug symbols...');

            let localVariables: VariableInfo[] = [];
            let globalVariables: VariableInfo[] = [];

            // Try to parse disassembly file if it exists
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspaceFolder) {
                const disasmPath = path.join(workspaceFolder, 'full_disasm.txt');

                if (fs.existsSync(disasmPath)) {
                    this.outputChannel.appendLine(`Found disassembly file: ${disasmPath}`);
                    const parsedVars = SymbolParser.parseDisassemblyFile(disasmPath);

                    // Separate by scope
                    localVariables = parsedVars.filter(v => v.scope === 'local' || v.scope === 'argument');
                    globalVariables = parsedVars.filter(v => v.scope === 'global' || v.scope === 'static');

                    this.outputChannel.appendLine(`Parsed ${parsedVars.length} variables from disassembly`);
                } else {
                    this.outputChannel.appendLine(`Tip: Generate disassembly with: tiarmobjdump -lS build/main.out > full_disasm.txt`);
                }

                // Try to find and parse ELF file directly
                const elfPath = SymbolParser.findElfFile(workspaceFolder);
                if (elfPath && fs.existsSync(elfPath)) {
                    this.outputChannel.appendLine(`Found ELF file: ${elfPath}`);

                    // Parse ELF symbol table directly
                    this.outputChannel.appendLine('Parsing ELF symbol table...');
                    const elfVars = SymbolParser.parseElfSymbols(elfPath);

                    if (elfVars.length > 0) {
                        this.outputChannel.appendLine(`Found ${elfVars.length} variables in ELF symbol table`);

                        // Separate by scope
                        localVariables = elfVars.filter(v => v.scope === 'local');
                        globalVariables = elfVars.filter(v => v.scope === 'global' || v.scope === 'static');
                    } else {
                        this.outputChannel.appendLine('No variables found in ELF symbol table');
                    }
                }
            }

            // If no variables from symbols, show registers as fallback
            if (localVariables.length === 0 && globalVariables.length === 0) {
                this.outputChannel.appendLine('No symbol data available, showing CPU registers...');

                try {
                    const allRegs = await this.readAllRegisters();
                    allRegs.forEach(reg => {
                        localVariables.push({
                            name: reg.name,
                            address: '(register)', // Registers don't have memory addresses
                            scope: 'local',
                            type: 'register',
                            value: reg.value
                        });
                    });
                } catch (error) {
                    this.outputChannel.appendLine(`Could not read registers: ${error}`);
                }
            }

            // Read actual memory values for variables with addresses
            // for (const variable of [...localVariables, ...globalVariables]) {
            //     // Skip registers and invalid addresses
            //     if (variable.address &&
            //         variable.address !== '0x0' &&
            //         variable.address !== '(register)' &&
            //         variable.type !== 'register') {
            //         try {
            //             const memResult = await this.readMemory(variable.address, 4);
            //             variable.value = memResult.data;
            //         } catch (error) {
            //             // Ignore read errors for individual variables
            //         }
            //     }
            // }

            const totalCount = localVariables.length + globalVariables.length;
            this.outputChannel.appendLine(`Variables: ${localVariables.length} local, ${globalVariables.length} global`);

            return {
                localVariables,
                globalVariables,
                totalCount,
                isValid: totalCount > 0,
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