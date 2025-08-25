import * as vscode from 'vscode';
import { SerialPort } from 'serialport';

export interface BoardInfo {
    port: string;
    manufacturer?: string;
    serialNumber?: string;
    productId?: string;
    vendorId?: string;
    friendlyName: string;
    isConnected: boolean;
}

export interface SerialConnectionOptions {
    port: string;
    baudRate: number;
    dataBits: 5 | 6 | 7 | 8;
    stopBits: 1 | 1.5 | 2;
    parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
}

export class SerialManager {
    private outputChannel: vscode.OutputChannel;
    private connectedPorts: Map<string, SerialPort> = new Map();
    private boardDetectionInterval?: NodeJS.Timeout;
    
    // Common VID/PID combinations for MSPM0 development boards
    private readonly MSPM0_BOARD_IDENTIFIERS = [
        { vendorId: '0451', productId: ['f432', 'bef3', 'bef4'], name: 'TI MSPM0 LaunchPad' },
        { vendorId: '1cbe', productId: ['00fd'], name: 'TI XDS110' }, // Common debug probe
        { vendorId: '0403', productId: ['6001', '6011'], name: 'FTDI USB-Serial' }, // Generic FTDI
        { vendorId: '10c4', productId: ['ea60'], name: 'Silicon Labs CP210x' } // Generic USB-Serial
    ];

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    async detectBoards(): Promise<BoardInfo[]> {
        try {
            const ports = await SerialPort.list();
            const boards: BoardInfo[] = [];

            for (const port of ports) {
                const boardInfo = this.identifyBoard(port);
                boards.push(boardInfo);
            }

            this.outputChannel.appendLine(`Detected ${boards.length} serial devices`);
            boards.forEach(board => {
                this.outputChannel.appendLine(`  - ${board.friendlyName} (${board.port})`);
            });

            return boards;
        } catch (error) {
            this.outputChannel.appendLine(`Error detecting boards: ${error}`);
            return [];
        }
    }

    async getConnectedMSPM0Boards(): Promise<BoardInfo[]> {
        const allBoards = await this.detectBoards();
        return allBoards.filter(board => this.isMSPM0Board(board));
    }

    private identifyBoard(port: any): BoardInfo {
        const vendorId = port.vendorId?.toLowerCase();
        const productId = port.productId?.toLowerCase();
        
        // Check against known MSPM0 board identifiers
        for (const identifier of this.MSPM0_BOARD_IDENTIFIERS) {
            if (vendorId === identifier.vendorId && 
                identifier.productId.includes(productId || '')) {
                return {
                    port: port.path,
                    manufacturer: port.manufacturer || identifier.name,
                    serialNumber: port.serialNumber,
                    productId: port.productId,
                    vendorId: port.vendorId,
                    friendlyName: `${identifier.name} (${port.path})`,
                    isConnected: false
                };
            }
        }

        // Generic board info for unknown devices
        return {
            port: port.path,
            manufacturer: port.manufacturer || 'Unknown',
            serialNumber: port.serialNumber,
            productId: port.productId,
            vendorId: port.vendorId,
            friendlyName: `${port.manufacturer || 'Unknown Device'} (${port.path})`,
            isConnected: false
        };
    }

    private isMSPM0Board(board: BoardInfo): boolean {
        const vendorId = board.vendorId?.toLowerCase();
        const productId = board.productId?.toLowerCase();
        
        return this.MSPM0_BOARD_IDENTIFIERS.some(identifier => 
            vendorId === identifier.vendorId && 
            identifier.productId.includes(productId || '')
        );
    }

    async getDefaultBoard(): Promise<BoardInfo | null> {
        const mspm0Boards = await this.getConnectedMSPM0Boards();
        
        if (mspm0Boards.length === 0) {
            // No MSPM0-specific boards found, get first available serial port
            const allBoards = await this.detectBoards();
            return allBoards.length > 0 ? allBoards[0] : null;
        }
        
        return mspm0Boards[0];
    }

    async connectToBoard(
        port: string, 
        options?: Partial<SerialConnectionOptions>
    ): Promise<SerialPort> {
        const defaultOptions: SerialConnectionOptions = {
            port,
            baudRate: 115200,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            ...options
        };

        try {
            if (this.connectedPorts.has(port)) {
                const existingPort = this.connectedPorts.get(port)!;
                if (existingPort.isOpen) {
                    this.outputChannel.appendLine(`Already connected to ${port}`);
                    return existingPort;
                }
            }

            this.outputChannel.appendLine(`Connecting to ${port} at ${defaultOptions.baudRate} baud`);

            const serialPort = new SerialPort({
                path: defaultOptions.port,
                baudRate: defaultOptions.baudRate,
                dataBits: defaultOptions.dataBits,
                stopBits: defaultOptions.stopBits,
                parity: defaultOptions.parity,
                autoOpen: false
            });

            return new Promise((resolve, reject) => {
                serialPort.open((error) => {
                    if (error) {
                        this.outputChannel.appendLine(`Failed to connect to ${port}: ${error.message}`);
                        reject(error);
                    } else {
                        this.outputChannel.appendLine(`Successfully connected to ${port}`);
                        this.connectedPorts.set(port, serialPort);
                        
                        // Set up error handling
                        serialPort.on('error', (err) => {
                            this.outputChannel.appendLine(`Serial port error on ${port}: ${err.message}`);
                            this.connectedPorts.delete(port);
                        });

                        serialPort.on('close', () => {
                            this.outputChannel.appendLine(`Serial port ${port} closed`);
                            this.connectedPorts.delete(port);
                        });

                        resolve(serialPort);
                    }
                });
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Connection error: ${errorMessage}`);
            throw error;
        }
    }

    async disconnectFromBoard(port: string): Promise<void> {
        const serialPort = this.connectedPorts.get(port);
        
        if (serialPort && serialPort.isOpen) {
            return new Promise((resolve, reject) => {
                serialPort.close((error) => {
                    if (error) {
                        this.outputChannel.appendLine(`Error closing ${port}: ${error.message}`);
                        reject(error);
                    } else {
                        this.outputChannel.appendLine(`Disconnected from ${port}`);
                        this.connectedPorts.delete(port);
                        resolve();
                    }
                });
            });
        } else {
            this.outputChannel.appendLine(`Port ${port} not connected`);
        }
    }

    async disconnectAll(): Promise<void> {
        const ports = Array.from(this.connectedPorts.keys());
        
        for (const port of ports) {
            try {
                await this.disconnectFromBoard(port);
            } catch (error) {
                this.outputChannel.appendLine(`Error disconnecting from ${port}: ${error}`);
            }
        }
    }

    isConnected(port: string): boolean {
        const serialPort = this.connectedPorts.get(port);
        return serialPort ? serialPort.isOpen : false;
    }

    getConnectedPorts(): string[] {
        return Array.from(this.connectedPorts.keys()).filter(port => this.isConnected(port));
    }

    startBoardDetection(intervalMs: number = 5000): void {
        if (this.boardDetectionInterval) {
            this.stopBoardDetection();
        }

        this.outputChannel.appendLine(`Starting board detection (checking every ${intervalMs}ms)`);
        
        this.boardDetectionInterval = setInterval(async () => {
            try {
                await this.detectBoards();
            } catch (error) {
                this.outputChannel.appendLine(`Board detection error: ${error}`);
            }
        }, intervalMs);
    }

    stopBoardDetection(): void {
        if (this.boardDetectionInterval) {
            clearInterval(this.boardDetectionInterval);
            this.boardDetectionInterval = undefined;
            this.outputChannel.appendLine('Stopped board detection');
        }
    }

    async writeToPort(port: string, data: string | Buffer): Promise<void> {
        const serialPort = this.connectedPorts.get(port);
        
        if (!serialPort || !serialPort.isOpen) {
            throw new Error(`Port ${port} is not connected`);
        }

        return new Promise((resolve, reject) => {
            serialPort.write(data, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    setupDataListener(port: string, callback: (data: Buffer) => void): void {
        const serialPort = this.connectedPorts.get(port);
        
        if (serialPort && serialPort.isOpen) {
            serialPort.on('data', callback);
        } else {
            throw new Error(`Port ${port} is not connected`);
        }
    }

    dispose(): void {
        this.stopBoardDetection();
        this.disconnectAll();
    }
}