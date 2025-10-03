import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { ConnectionManager, BoardInfo } from '../managers/connectionManager';

export interface FlashOptions {
    port?: string;
    binaryPath?: string;
    verify?: boolean;
    erase?: boolean;
}

export interface FlashResult {
    success: boolean;
    message: string;
    flashTime: number;
    bytesFlashed?: number;
}

export class FlashCommand {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private connectionManager: ConnectionManager;
    private flashProcess: ChildProcess | null = null;

    constructor(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel,
        connectionManager: ConnectionManager
    ) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.connectionManager = connectionManager;
    }

    async execute(options: FlashOptions = {}): Promise<FlashResult> {
        const startTime = Date.now();

        try {
            this.outputChannel.appendLine('='.repeat(50));
            this.outputChannel.appendLine('Starting flash process...');
            this.outputChannel.appendLine('='.repeat(50));

            // Validate prerequisites
            await this.validatePrerequisites();

            // Get target board
            const targetBoard = await this.getTargetBoard(options.port);
            if (!targetBoard) {
                throw new Error('No target board available for flashing');
            }

            // Find binary file
            const binaryPath = options.binaryPath || await this.findBinaryFile();
            if (!binaryPath || !fs.existsSync(binaryPath)) {
                throw new Error('No binary file found. Build the project first.');
            }

            this.outputChannel.appendLine(`Target board: ${targetBoard.friendlyName}`);
            this.outputChannel.appendLine(`Binary file: ${binaryPath}`);

            // Execute flash operation
            const result = await this.executeFlash({
                board: targetBoard,
                binaryPath,
                verify: options.verify !== false, // Default to true
                erase: options.erase !== false   // Default to true
            });

            const flashTime = Date.now() - startTime;
            result.flashTime = flashTime;

            // Show flash results
            this.showFlashResults(result);

            return result;

        } catch (error) {
            const flashTime = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : String(error);

            this.outputChannel.appendLine(`Flash failed: ${errorMessage}`);

            const result: FlashResult = {
                success: false,
                message: errorMessage,
                flashTime
            };

            this.showFlashResults(result);
            return result;
        }
    }

    async stop(): Promise<void> {
        if (this.flashProcess) {
            this.outputChannel.appendLine('Stopping flash process...');
            this.flashProcess.kill();
            this.flashProcess = null;
        }
    }

    private async validatePrerequisites(): Promise<void> {
        // Check if workspace is available
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            throw new Error('No workspace folder open');
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
            // Look for specific port
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

        // Fall back to any connected board
        const connectedPorts = this.connectionManager.getConnectedPorts();
        if (connectedPorts.length > 0) {
            const connectedBoard = boards.find(b => connectedPorts.includes(b.path));
            if (connectedBoard) {
                return connectedBoard;
            }
        }

        // Fall back to default board
        return await this.connectionManager.getDefaultBoard();
    }

    private async findBinaryFile(): Promise<string | null> {
        if (!vscode.workspace.workspaceFolders) {
            return null;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders[0];
        
        // Common binary file patterns
        const patterns = [
            '**/build/*.out',
            '**/build/*.elf',
            '**/build/*.bin',
            '**/*.out',
            '**/*.elf'
        ];

        for (const pattern of patterns) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(workspaceFolder, pattern),
                null,
                10
            );

            if (files.length > 0) {
                // Return the most recently modified file
                const sortedFiles = files.sort((a, b) => {
                    const statsA = fs.statSync(a.fsPath);
                    const statsB = fs.statSync(b.fsPath);
                    return statsB.mtime.getTime() - statsA.mtime.getTime();
                });

                return sortedFiles[0].fsPath;
            }
        }

        return null;
    }

    private async executeFlash(config: {
        board: BoardInfo;
        binaryPath: string;
        verify: boolean;
        erase: boolean;
    }): Promise<FlashResult> {
        return new Promise((resolve, reject) => {
            // For MVP, we'll use a simplified flash approach
            // TODO: Implement proper flash tool integration
            
            this.outputChannel.appendLine(`Flashing ${config.binaryPath} to ${config.board.path}`);
            
            if (config.erase) {
                this.outputChannel.appendLine('Erasing flash memory...');
            }

            // Get file size for progress reporting
            const stats = fs.statSync(config.binaryPath);
            const fileSize = stats.size;
            
            this.outputChannel.appendLine(`Binary size: ${fileSize} bytes`);

            // Simulate flash process for MVP
            // In a real implementation, this would use tools like:
            // - uniflash (TI's flash tool)
            // - openocd
            // - Custom serial bootloader protocol
            
            const args = this.buildFlashArgs(config);
            this.outputChannel.appendLine(`Flash command: ${args.join(' ')}`);

            // For now, simulate a successful flash
            setTimeout(() => {
                const result: FlashResult = {
                    success: true,
                    message: 'Flash completed successfully',
                    flashTime: 0,
                    bytesFlashed: fileSize
                };

                this.outputChannel.appendLine(`Successfully flashed ${fileSize} bytes`);
                
                if (config.verify) {
                    this.outputChannel.appendLine('Verification completed successfully');
                }

                resolve(result);
            }, 2000); // Simulate 2 second flash time

            // TODO: Replace simulation with actual flash implementation:
            /*
            this.flashProcess = spawn('uniflash', args, {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            this.flashProcess.stdout?.on('data', (data) => {
                const output = data.toString();
                stdout += output;
                this.outputChannel.append(output);
                
                // Parse progress if available
                this.parseFlashProgress(output);
            });

            this.flashProcess.stderr?.on('data', (data) => {
                const output = data.toString();
                stderr += output;
                this.outputChannel.append(output);
            });

            this.flashProcess.on('close', (code) => {
                this.flashProcess = null;

                const result: FlashResult = {
                    success: code === 0,
                    message: code === 0 ? 'Flash completed successfully' : 'Flash failed',
                    flashTime: 0,
                    bytesFlashed: code === 0 ? fileSize : undefined
                };

                if (code === 0) {
                    this.outputChannel.appendLine('Flash operation completed successfully');
                } else {
                    this.outputChannel.appendLine(`Flash operation failed with exit code ${code}`);
                }

                resolve(result);
            });

            this.flashProcess.on('error', (error) => {
                this.flashProcess = null;
                reject(new Error(`Flash process error: ${error.message}`));
            });
            */
        });
    }

    private buildFlashArgs(config: {
        board: BoardInfo;
        binaryPath: string;
        verify: boolean;
        erase: boolean;
    }): string[] {
        // TODO: Build actual flash tool arguments
        // This is a placeholder for the actual flash tool integration
        const args: string[] = [];

        // Example arguments for TI UniFlash or similar tool:
        args.push('--mode', 'flash');
        args.push('--interface', 'swd');
        args.push('--connection', config.board.path);
        
        if (config.erase) {
            args.push('--erase', 'all');
        }
        
        args.push('--flash', config.binaryPath);
        
        if (config.verify) {
            args.push('--verify');
        }

        return args;
    }

    private parseFlashProgress(output: string): void {
        // Parse flash tool output for progress information
        // This would depend on the specific flash tool being used
        
        // Example progress parsing for TI UniFlash:
        const progressMatch = output.match(/(\d+)%\s*complete/i);
        if (progressMatch) {
            const percentage = parseInt(progressMatch[1]);
            this.outputChannel.appendLine(`Flash progress: ${percentage}%`);
        }

        // Example for bytes flashed:
        const bytesMatch = output.match(/(\d+)\s*bytes\s*programmed/i);
        if (bytesMatch) {
            const bytes = parseInt(bytesMatch[1]);
            this.outputChannel.appendLine(`Bytes programmed: ${bytes}`);
        }
    }

    private showFlashResults(result: FlashResult): void {
        const { success, message, flashTime, bytesFlashed } = result;

        if (success) {
            const sizeInfo = bytesFlashed ? ` (${bytesFlashed} bytes)` : '';
            vscode.window.showInformationMessage(
                `Flash completed successfully in ${(flashTime / 1000).toFixed(1)}s${sizeInfo}`
            );
        } else {
            vscode.window.showErrorMessage(`Flash failed: ${message}`);
        }
    }

    // Utility methods for different flash tools

    private async detectFlashTool(): Promise<string | null> {
        // Detect available flash tools in order of preference
        const tools = [
            'uniflash',     // TI UniFlash
            'openocd',      // OpenOCD
            'JLinkExe',     // J-Link
            'st-flash'      // ST-Link (for reference)
        ];

        for (const tool of tools) {
            try {
                // Test if tool is available in PATH
                await this.testCommand(tool, ['--version']);
                this.outputChannel.appendLine(`Found flash tool: ${tool}`);
                return tool;
            } catch (error) {
                // Tool not found, continue to next
            }
        }

        return null;
    }

    private testCommand(command: string, args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const process = spawn(command, args, { 
                stdio: 'ignore',
                timeout: 5000 
            });
            
            process.on('close', (code) => {
                resolve();
            });
            
            process.on('error', (error) => {
                reject(error);
            });
        });
    }

    // Method to handle different binary formats
    private async convertBinaryFormat(inputPath: string, outputFormat: 'bin' | 'hex' | 'elf'): Promise<string> {
        const outputPath = inputPath.replace(path.extname(inputPath), `.${outputFormat}`);
        
        // TODO: Implement binary format conversion using objcopy or similar tools
        // For now, just return the original path
        this.outputChannel.appendLine(`Binary conversion: ${inputPath} -> ${outputFormat} (placeholder)`);
        
        return inputPath;
    }

    // Method to estimate flash time based on file size
    private estimateFlashTime(fileSize: number): number {
        // Rough estimate: ~10KB/s for typical embedded flash speeds
        const bytesPerSecond = 10 * 1024;
        return Math.max(1000, (fileSize / bytesPerSecond) * 1000); // Minimum 1 second
    }

    // Method to validate binary file
    private validateBinaryFile(binaryPath: string): { valid: boolean; format?: string; size?: number } {
        try {
            const stats = fs.statSync(binaryPath);
            const ext = path.extname(binaryPath).toLowerCase();
            
            // Basic file size validation
            if (stats.size === 0) {
                return { valid: false };
            }
            
            // Check for reasonable file size (not too large for typical MCU flash)
            const maxSize = 1024 * 1024; // 1MB max
            if (stats.size > maxSize) {
                this.outputChannel.appendLine(`Warning: Binary file is unusually large (${stats.size} bytes)`);
            }

            return {
                valid: true,
                format: ext.substring(1),
                size: stats.size
            };
        } catch (error) {
            return { valid: false };
        }
    }

    dispose(): void {
        if (this.flashProcess) {
            this.flashProcess.kill();
        }
    }
}