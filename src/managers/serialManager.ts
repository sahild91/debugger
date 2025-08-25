import * as vscode from 'vscode';

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
    private connectedPorts: Map<string, any> = new Map();
    private boardDetectionInterval?: NodeJS.Timeout;
    
    // Mock board data for testing
    private mockBoards: BoardInfo[] = [
        {
            port: 'COM3',
            manufacturer: 'Texas Instruments',
            serialNumber: 'TI12345',
            productId: 'f432',
            vendorId: '0451',
            friendlyName: 'TI MSPM0 LaunchPad (COM3)',
            isConnected: false
        },
        {
            port: '/dev/ttyUSB0',
            manufacturer: 'FTDI',
            serialNumber: 'FT12345',
            productId: '6001',
            vendorId: '0403',
            friendlyName: 'FTDI USB-Serial (/dev/ttyUSB0)',
            isConnected: false
        }
    ];

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.outputChannel.appendLine('SerialManager: Using mock implementation (serialport not available)');
    }

    async detectBoards(): Promise<BoardInfo[]> {
        try {
            this.outputChannel.appendLine('SerialManager: Detecting boards (mock)...');
            
            // Simulate detection delay
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Return platform-appropriate mock data
            const isWindows = process.platform === 'win32';
            const boards = isWindows ? 
                this.mockBoards.filter(b => b.port.startsWith('COM')) :
                this.mockBoards.filter(b => b.port.startsWith('/dev'));

            this.outputChannel.appendLine(`SerialManager: Found ${boards.length} mock boards`);
            boards.forEach(board => {
                this.outputChannel.appendLine(`  - ${board.friendlyName}`);
            });

            return boards;
        } catch (error) {
            this.outputChannel.appendLine(`SerialManager: Error detecting boards: ${error}`);
            return [];
        }
    }

    async getConnectedMSPM0Boards(): Promise<BoardInfo[]> {
        const allBoards = await this.detectBoards();
        return allBoards.filter(board => this.isMSPM0Board(board));
    }

    private isMSPM0Board(board: BoardInfo): boolean {
        const vendorId = board.vendorId?.toLowerCase();
        return vendorId === '0451'; // TI vendor ID
    }

    async getDefaultBoard(): Promise<BoardInfo | null> {
        const mspm0Boards = await this.getConnectedMSPM0Boards();
        
        if (mspm0Boards.length === 0) {
            const allBoards = await this.detectBoards();
            return allBoards.length > 0 ? allBoards[0] : null;
        }
        
        return mspm0Boards[0];
    }

    async connectToBoard(port: string, options?: Partial<SerialConnectionOptions>): Promise<any> {
        try {
            this.outputChannel.appendLine(`SerialManager: Mock connecting to ${port}`);
            
            // Simulate connection delay
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Mock connection object
            const mockConnection = {
                isOpen: true,
                port: port,
                on: (event: string, callback: Function) => {
                    // Mock event handling
                },
                close: (callback?: Function) => {
                    if (callback) callback();
                },
                write: (data: string | Buffer, callback?: Function) => {
                    if (callback) callback();
                }
            };
            
            this.connectedPorts.set(port, mockConnection);
            this.outputChannel.appendLine(`SerialManager: Successfully connected to ${port} (mock)`);
            
            return mockConnection;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`SerialManager: Connection error: ${errorMessage}`);
            throw error;
        }
    }

    async disconnectFromBoard(port: string): Promise<void> {
        const connection = this.connectedPorts.get(port);
        
        if (connection) {
            // Simulate disconnection
            await new Promise(resolve => setTimeout(resolve, 500));
            this.connectedPorts.delete(port);
            this.outputChannel.appendLine(`SerialManager: Disconnected from ${port} (mock)`);
        } else {
            this.outputChannel.appendLine(`SerialManager: Port ${port} not connected`);
        }
    }

    async disconnectAll(): Promise<void> {
        const ports = Array.from(this.connectedPorts.keys());
        
        for (const port of ports) {
            try {
                await this.disconnectFromBoard(port);
            } catch (error) {
                this.outputChannel.appendLine(`SerialManager: Error disconnecting from ${port}: ${error}`);
            }
        }
    }

    isConnected(port: string): boolean {
        const connection = this.connectedPorts.get(port);
        return connection ? connection.isOpen : false;
    }

    getConnectedPorts(): string[] {
        return Array.from(this.connectedPorts.keys()).filter(port => this.isConnected(port));
    }

    startBoardDetection(intervalMs: number = 5000): void {
        if (this.boardDetectionInterval) {
            this.stopBoardDetection();
        }

        this.outputChannel.appendLine(`SerialManager: Starting board detection (mock, checking every ${intervalMs}ms)`);
        
        this.boardDetectionInterval = setInterval(async () => {
            try {
                await this.detectBoards();
            } catch (error) {
                this.outputChannel.appendLine(`SerialManager: Board detection error: ${error}`);
            }
        }, intervalMs);
    }

    stopBoardDetection(): void {
        if (this.boardDetectionInterval) {
            clearInterval(this.boardDetectionInterval);
            this.boardDetectionInterval = undefined;
            this.outputChannel.appendLine('SerialManager: Stopped board detection');
        }
    }

    async writeToPort(port: string, data: string | Buffer): Promise<void> {
        const connection = this.connectedPorts.get(port);
        
        if (!connection || !connection.isOpen) {
            throw new Error(`Port ${port} is not connected`);
        }

        // Mock write operation
        this.outputChannel.appendLine(`SerialManager: Mock writing to ${port}: ${data}`);
        return Promise.resolve();
    }

    setupDataListener(port: string, callback: (data: Buffer) => void): void {
        const connection = this.connectedPorts.get(port);
        
        if (connection && connection.isOpen) {
            // Mock data listener setup
            this.outputChannel.appendLine(`SerialManager: Mock data listener setup for ${port}`);
        } else {
            throw new Error(`Port ${port} is not connected`);
        }
    }

    dispose(): void {
        this.stopBoardDetection();
        this.disconnectAll();
    }
}