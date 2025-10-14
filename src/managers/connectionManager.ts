import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

const execAsync = promisify(exec);

export interface SerialPort {
    path: string;
    manufacturer?: string;
    serialNumber?: string;
    vendorId?: string;
    productId?: string;
    deviceType?: 'MSPM0' | 'ESP32' | 'Arduino' | 'MCP' | 'Unknown';
}

// Alias for backward compatibility with other code
export interface BoardInfo extends SerialPort {
    friendlyName: string;
    isConnected: boolean;
}

export class ConnectionManager {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private selectedPort: string | null = null;
    private selectedPortInfo: SerialPort | null = null;
    private deviceCheckInterval: NodeJS.Timeout | null = null;
    private lastKnownPorts: string[] = [];
    private eventEmitter: EventEmitter = new EventEmitter();

    // GlobalState keys for persistent storage
    private readonly SELECTED_PORT_KEY = 'mspm0.selectedPort';
    private readonly SELECTED_PORT_INFO_KEY = 'mspm0.selectedPortInfo';
    private readonly PORT_LAST_SELECTED_KEY = 'mspm0.portLastSelected';

    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        this.context = context;
        this.outputChannel = outputChannel;

        // Auto-load saved port on initialization
        this.loadSavedPort();

        // ✅ Start monitoring port changes
        this.startPortMonitoring();
    }

    /**
     * Save selected port to globalState for persistence
     */
    private async saveSelectedPort(port: string, portInfo?: SerialPort): Promise<void> {
        try {
            await this.context.globalState.update(this.SELECTED_PORT_KEY, port);
            if (portInfo) {
                await this.context.globalState.update(this.SELECTED_PORT_INFO_KEY, portInfo);
            }
            await this.context.globalState.update(this.PORT_LAST_SELECTED_KEY, new Date().toISOString());
            this.outputChannel.appendLine(`Saved selected port: ${port}`);
        } catch (error) {
            this.outputChannel.appendLine(`Failed to save selected port: ${error}`);
        }
    }

    private startPortMonitoring(): void {
        this.deviceCheckInterval = setInterval(async () => {
            try {
                const currentPorts = await this.getAvailablePorts();
                const currentPortPaths = currentPorts.map(p => p.path);

                // Check if any ports were removed
                const removedPorts = this.lastKnownPorts.filter(
                    port => !currentPortPaths.includes(port)
                );

                // Check if the selected port was removed
                if (this.selectedPort && removedPorts.includes(this.selectedPort)) {
                    this.outputChannel.appendLine(`Selected port ${this.selectedPort} was disconnected`);
                    this.eventEmitter.emit('portDisconnected', this.selectedPort);

                    // Clear the selected port
                    this.selectedPort = null;
                    this.selectedPortInfo = null;
                    await this.clearSavedPort();
                }

                // Check if new ports were added
                const addedPorts = currentPortPaths.filter(
                    port => !this.lastKnownPorts.includes(port)
                );

                if (addedPorts.length > 0) {
                    this.eventEmitter.emit('portAdded', addedPorts);
                }

                this.lastKnownPorts = currentPortPaths;
            } catch (error) {
                // Ignore errors during monitoring
            }
        }, 5000);  // Check every 2 seconds
    }

    /**
     * Listen for port disconnection events
     */
    public onPortDisconnected(callback: (port: string) => void): void {
        this.eventEmitter.on('portDisconnected', callback);
    }

    /**
     * Listen for port added events
     */
    public onPortAdded(callback: (ports: string[]) => void): void {
        this.eventEmitter.on('portAdded', callback);
    }

    /**
     * Stop port monitoring (cleanup)
     */
    public stopPortMonitoring(): void {
        if (this.deviceCheckInterval) {
            clearInterval(this.deviceCheckInterval);
            this.deviceCheckInterval = null;
        }
    }

    /**
     * Load saved port from globalState
     */
    private async loadSavedPort(): Promise<void> {
        try {
            const savedPort = this.context.globalState.get<string>(this.SELECTED_PORT_KEY);
            const savedPortInfo = this.context.globalState.get<SerialPort>(this.SELECTED_PORT_INFO_KEY);

            if (savedPort) {
                // Verify the port still exists
                const availablePorts = await this.getAvailablePorts();
                const portExists = availablePorts.find(p => p.path === savedPort);

                if (portExists) {
                    this.selectedPort = savedPort;
                    this.selectedPortInfo = savedPortInfo || portExists;
                    this.outputChannel.appendLine(`Loaded saved port: ${savedPort}`);
                } else {
                    this.outputChannel.appendLine(`Saved port ${savedPort} no longer available`);
                    await this.clearSavedPort();
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(`Failed to load saved port: ${error}`);
        }
    }

    /**
     * Clear saved port (useful for troubleshooting)
     */
    private async clearSavedPort(): Promise<void> {
        await this.context.globalState.update(this.SELECTED_PORT_KEY, undefined);
        await this.context.globalState.update(this.SELECTED_PORT_INFO_KEY, undefined);
        await this.context.globalState.update(this.PORT_LAST_SELECTED_KEY, undefined);
    }

    async getAvailablePorts(): Promise<SerialPort[]> {
        const platform = process.platform;

        try {
            switch (platform) {
                case 'darwin':
                    return await this.getMacPorts();
                case 'win32':
                    return await this.getWindowsPorts();
                case 'linux':
                    return await this.getLinuxPorts();
                default:
                    throw new Error(`Unsupported platform: ${platform}`);
            }
        } catch (error) {
            this.outputChannel.appendLine(`Error getting ports: ${error}`);
            throw error;
        }
    }

    private async getMacPorts(): Promise<SerialPort[]> {
        const ports: SerialPort[] = [];

        // Get basic port list
        try {
            const { stdout } = await execAsync('ls /dev/cu.* /dev/tty.* 2>/dev/null | grep -E "(usbserial|usbmodem|USB)" || true');
            const portPaths = stdout.trim().split('\n').filter(path => path.trim());

            for (const portPath of portPaths) {
                const port: SerialPort = {
                    path: portPath,
                    deviceType: 'Unknown'
                };

                // Try to get device info using system_profiler
                try {
                    const { stdout: usbInfo } = await execAsync(`system_profiler SPUSBDataType 2>/dev/null`);
                    const deviceInfo = this.parseUSBInfo(usbInfo, portPath);

                    if (deviceInfo) {
                        port.manufacturer = deviceInfo.manufacturer;
                        port.serialNumber = deviceInfo.serialNumber;
                        port.vendorId = deviceInfo.vendorId;
                        port.productId = deviceInfo.productId;
                        port.deviceType = this.identifyDeviceType(deviceInfo.vendorId, deviceInfo.productId);
                    }
                } catch (error) {
                    // Continue without device info
                }

                ports.push(port);
            }
        } catch (error) {
            this.outputChannel.appendLine(`Warning: Could not list macOS ports: ${error}`);
        }

        return ports;
    }

    private async getWindowsPorts(): Promise<SerialPort[]> {
        const ports: SerialPort[] = [];

        try {
            const command = `powershell -Command "Get-WmiObject -Query \\"SELECT * FROM Win32_SerialPort\\" | ForEach-Object { $_.Caption + '|' + $_.DeviceID + '|' + $_.Manufacturer }"`;
            const { stdout } = await execAsync(command);

            const lines = stdout.trim().split('\n');
            for (const line of lines) {
                if (line.trim()) {
                    const [caption, deviceId, manufacturer] = line.split('|');
                    const comMatch = caption.match(/COM(\d+)/);

                    if (comMatch) {
                        const port: SerialPort = {
                            path: comMatch[0],
                            manufacturer: manufacturer?.trim(),
                            deviceType: 'Unknown'
                        };

                        // Extract VID/PID from device ID
                        const vidPidMatch = deviceId?.match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i);
                        if (vidPidMatch) {
                            port.vendorId = vidPidMatch[1];
                            port.productId = vidPidMatch[2];
                            port.deviceType = this.identifyDeviceType(port.vendorId, port.productId);
                        }

                        ports.push(port);
                    }
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(`Warning: Could not list Windows ports: ${error}`);
        }

        return ports;
    }

    private async getLinuxPorts(): Promise<SerialPort[]> {
        const ports: SerialPort[] = [];

        try {
            // Get serial ports
            const { stdout } = await execAsync('ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true');
            const portPaths = stdout.trim().split('\n').filter(path => path.trim());

            for (const portPath of portPaths) {
                const port: SerialPort = {
                    path: portPath,
                    deviceType: 'Unknown'
                };

                // Try to get device info using udevadm
                try {
                    const { stdout: udevInfo } = await execAsync(`udevadm info -a -n ${portPath} 2>/dev/null || true`);
                    const deviceInfo = this.parseLinuxUdevInfo(udevInfo);

                    if (deviceInfo) {
                        port.manufacturer = deviceInfo.manufacturer;
                        port.vendorId = deviceInfo.vendorId;
                        port.productId = deviceInfo.productId;
                        port.deviceType = this.identifyDeviceType(deviceInfo.vendorId, deviceInfo.productId);
                    }
                } catch (error) {
                    // Continue without device info
                }

                ports.push(port);
            }
        } catch (error) {
            this.outputChannel.appendLine(`Warning: Could not list Linux ports: ${error}`);
        }

        return ports;
    }

    private parseUSBInfo(usbInfo: string, portPath: string): any {
        const lines = usbInfo.split('\n');
        let currentDevice: any = null;
        let inUSBDevice = false;

        for (const line of lines) {
            if (line.trim().includes('USB') && line.includes(':')) {
                inUSBDevice = true;
                currentDevice = {};
            } else if (inUSBDevice && line.trim() === '') {
                inUSBDevice = false;
                currentDevice = null;
            } else if (inUSBDevice && currentDevice) {
                if (line.includes('Vendor ID:')) {
                    const match = line.match(/0x([0-9a-f]{4})/i);
                    if (match) currentDevice.vendorId = match[1].toUpperCase();
                } else if (line.includes('Product ID:')) {
                    const match = line.match(/0x([0-9a-f]{4})/i);
                    if (match) currentDevice.productId = match[1].toUpperCase();
                } else if (line.includes('Manufacturer:')) {
                    currentDevice.manufacturer = line.split(':')[1]?.trim();
                } else if (line.includes('Serial Number:')) {
                    currentDevice.serialNumber = line.split(':')[1]?.trim();
                }
            }
        }

        return currentDevice;
    }

    private parseLinuxUdevInfo(udevInfo: string): any {
        const deviceInfo: any = {};
        const lines = udevInfo.split('\n');

        for (const line of lines) {
            if (line.includes('ID_VENDOR_ID')) {
                const match = line.match(/ID_VENDOR_ID="([^"]+)"/);
                if (match) deviceInfo.vendorId = match[1].toUpperCase();
            } else if (line.includes('ID_MODEL_ID')) {
                const match = line.match(/ID_MODEL_ID="([^"]+)"/);
                if (match) deviceInfo.productId = match[1].toUpperCase();
            } else if (line.includes('ID_VENDOR_FROM_DATABASE')) {
                const match = line.match(/ID_VENDOR_FROM_DATABASE="([^"]+)"/);
                if (match) deviceInfo.manufacturer = match[1];
            }
        }

        return Object.keys(deviceInfo).length > 0 ? deviceInfo : null;
    }

    private identifyDeviceType(vendorId?: string, productId?: string): 'MSPM0' | 'ESP32' | 'Arduino' | 'MCP' | 'Unknown' {
        if (!vendorId) return 'Unknown';

        const vid = vendorId.toUpperCase();

        // Device type mapping
        const deviceMap: { [key: string]: 'MSPM0' | 'ESP32' | 'Arduino' | 'MCP' } = {
            '0451': 'MSPM0',      // Texas Instruments (MSPM0)
            '10C4': 'ESP32',      // Silicon Labs (used by many ESP32 boards)
            '1A86': 'ESP32',      // QinHeng Electronics (CH340)
            '0403': 'ESP32',      // FTDI (used by some ESP32 boards)
            '2341': 'Arduino',    // Arduino LLC
            '2A03': 'Arduino',    // Arduino SRL
            '04D8': 'MCP',        // Microchip Technology
        };

        return deviceMap[vid] || 'Unknown';
    }

    async showPortSelection(): Promise<string | undefined> {
        try {
            const ports = await this.getAvailablePorts();

            if (ports.length === 0) {
                vscode.window.showWarningMessage('No serial ports found. Please connect your device and try again.');
                return undefined;
            }

            // Create quick pick items
            const items = ports.map(port => ({
                label: port.path,
                description: port.deviceType !== 'Unknown' ? port.deviceType : undefined,
                detail: [
                    port.manufacturer && `Manufacturer: ${port.manufacturer}`,
                    port.vendorId && port.productId && `VID:PID ${port.vendorId}:${port.productId}`,
                    port.serialNumber && `SN: ${port.serialNumber}`
                ].filter(Boolean).join(' | ') || 'No additional info',
                port: port
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a serial port to connect',
                title: 'Available Serial Ports'
            });

            if (selected) {
                const selectedPortInfo = selected.port;

                // Store the selected port information
                this.selectedPort = selectedPortInfo.path;
                this.selectedPortInfo = selectedPortInfo;

                // Save to globalState
                await this.saveSelectedPort(selectedPortInfo.path, selectedPortInfo);

                const deviceInfo = [
                    `Port: ${selectedPortInfo.path}`,
                    selectedPortInfo.deviceType !== 'Unknown' && `Type: ${selectedPortInfo.deviceType}`,
                    selectedPortInfo.manufacturer && `Manufacturer: ${selectedPortInfo.manufacturer}`,
                    selectedPortInfo.vendorId && selectedPortInfo.productId && `VID:PID ${selectedPortInfo.vendorId}:${selectedPortInfo.productId}`
                ].filter(Boolean).join('\n');

                vscode.window.showInformationMessage(`Connected to:\n${deviceInfo}`);
                this.outputChannel.appendLine(`Connected to port: ${selectedPortInfo.path}`);

                if (selectedPortInfo.deviceType !== 'Unknown') {
                    this.outputChannel.appendLine(`Device type: ${selectedPortInfo.deviceType}`);
                }

                return selectedPortInfo.path;
            }

            return undefined;
        } catch (error) {
            const errorMessage = `Failed to get available ports: ${error}`;
            vscode.window.showErrorMessage(errorMessage);
            this.outputChannel.appendLine(`${errorMessage}`);
            return undefined;
        }
    }

    getSelectedPort(): string | null {
        return this.selectedPort;
    }

    getSelectedPortInfo(): SerialPort | null {
        return this.selectedPortInfo;
    }

    isPortSelected(): boolean {
        return this.selectedPort !== null;
    }

    async disconnect(): Promise<void> {
        if (this.selectedPort) {
            this.outputChannel.appendLine(`Disconnected from port: ${this.selectedPort}`);
            vscode.window.showInformationMessage(`Disconnected from ${this.selectedPort}`);
        }
        this.selectedPort = null;
        this.selectedPortInfo = null;

        // Clear from globalState
        await this.clearSavedPort();
    }

    getPortStatusText(): string {
        if (this.selectedPort) {
            const deviceType = this.selectedPortInfo?.deviceType !== 'Unknown' && this.selectedPortInfo?.deviceType
                ? ` (${this.selectedPortInfo?.deviceType})`
                : '';
            return `${this.selectedPort}${deviceType}`;
        }
        return 'No port selected';
    }

    // ========================================
    // MSPM0-Specific Board Detection Methods
    // (for backward compatibility with SerialManager)
    // ========================================

    /**
     * Detect boards and return as BoardInfo format
     */
    async detectBoards(): Promise<BoardInfo[]> {
        try {
            this.outputChannel.appendLine('Detecting boards...');
            const ports = await this.getAvailablePorts();

            // Convert to BoardInfo format
            const boards: BoardInfo[] = ports.map(port => ({
                ...port,
                friendlyName: this.getBoardFriendlyName(port),
                isConnected: this.selectedPort === port.path
            }));

            this.outputChannel.appendLine(`Found ${boards.length} board(s)`);
            boards.forEach(board => {
                this.outputChannel.appendLine(`  - ${board.friendlyName}`);
            });

            return boards;
        } catch (error) {
            this.outputChannel.appendLine(`Error detecting boards: ${error}`);
            return [];
        }
    }

    /**
     * Get only MSPM0 boards
     */
    async getConnectedMSPM0Boards(): Promise<BoardInfo[]> {
        const allBoards = await this.detectBoards();
        return allBoards.filter(board => this.isMSPM0Board(board));
    }

    /**
     * Check if a board is an MSPM0 board
     */
    private isMSPM0Board(board: BoardInfo | SerialPort): boolean {
        const vendorId = board.vendorId?.toLowerCase();
        return vendorId === '0451' || board.deviceType === 'MSPM0'; // TI vendor ID
    }

    /**
     * Get default board (prioritize MSPM0, then any board)
     */
    async getDefaultBoard(): Promise<BoardInfo | null> {
        const mspm0Boards = await this.getConnectedMSPM0Boards();

        if (mspm0Boards.length === 0) {
            const allBoards = await this.detectBoards();
            return allBoards.length > 0 ? allBoards[0] : null;
        }

        return mspm0Boards[0];
    }

    /**
     * Get friendly board name
     */
    private getBoardFriendlyName(port: SerialPort): string {
        if (port.deviceType === 'MSPM0') {
            return `TI MSPM0 LaunchPad (${port.path})`;
        } else if (port.manufacturer && port.deviceType !== 'Unknown') {
            return `${port.manufacturer} ${port.deviceType} (${port.path})`;
        } else if (port.manufacturer) {
            return `${port.manufacturer} (${port.path})`;
        } else if (port.deviceType !== 'Unknown') {
            return `${port.deviceType} Device (${port.path})`;
        }
        return `Serial Device (${port.path})`;
    }

    /**
     * Auto-select port if only one MSPM0 board is available
     */
    async autoSelectPort(): Promise<boolean> {
        try {
            // If already have a saved port and it's valid, keep it
            if (this.selectedPort) {
                const ports = await this.getAvailablePorts();
                if (ports.find(p => p.path === this.selectedPort)) {
                    this.outputChannel.appendLine(`Auto-selected saved port: ${this.selectedPort}`);
                    return true;
                }
            }

            // Try to auto-select if only one MSPM0 board
            const mspm0Boards = await this.getConnectedMSPM0Boards();
            if (mspm0Boards.length === 1) {
                this.selectedPort = mspm0Boards[0].path;
                this.selectedPortInfo = mspm0Boards[0];
                await this.saveSelectedPort(this.selectedPort, this.selectedPortInfo);
                this.outputChannel.appendLine(`Auto-selected MSPM0 board: ${this.selectedPort}`);
                return true;
            }

            return false;
        } catch (error) {
            this.outputChannel.appendLine(`Auto-select failed: ${error}`);
            return false;
        }
    }

    // ========================================
    // Connection Management Methods
    // (for compatibility with debugCommand, flashCommand)
    // ========================================

    /**
     * Connect to a board on a specific port
     * @param port - Serial port path to connect to
     * @param options - Optional connection options (baudRate, etc.)
     */
    async connectToBoard(port: string, options?: any): Promise<void> {
        try {
            this.outputChannel.appendLine(`Connecting to board on ${port}...`);

            // Verify the port exists
            const availablePorts = await this.getAvailablePorts();
            const portInfo = availablePorts.find(p => p.path === port);

            if (!portInfo) {
                throw new Error(`Port ${port} not found. Please check the connection.`);
            }

            // Set as selected port
            this.selectedPort = port;
            this.selectedPortInfo = portInfo;

            // Save to globalState
            await this.saveSelectedPort(port, portInfo);

            this.outputChannel.appendLine(`Connected to ${port}`);
            if (portInfo.deviceType !== 'Unknown') {
                this.outputChannel.appendLine(`   Device type: ${portInfo.deviceType}`);
            }

            // Note: Actual serial port communication would be handled by the SWD debugger CLI
            // This method just manages the connection state for the extension
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Connection failed: ${errorMessage}`);
            throw error;
        }
    }

    /**
     * Disconnect from a specific board port
     * @param port - Serial port path to disconnect from
     */
    async disconnectFromBoard(port: string): Promise<void> {
        try {
            if (this.selectedPort === port) {
                this.outputChannel.appendLine(`Disconnecting from ${port}...`);

                this.selectedPort = null;
                this.selectedPortInfo = null;

                // Clear from globalState
                await this.clearSavedPort();

                this.outputChannel.appendLine(`Disconnected from ${port}`);
            } else {
                this.outputChannel.appendLine(`Port ${port} is not the currently selected port`);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Disconnection failed: ${errorMessage}`);
            throw error;
        }
    }

    /**
     * Check if a specific port is connected (selected)
     * @param port - Serial port path to check
     */
    isConnected(port: string): boolean {
        return this.selectedPort === port;
    }

    /**
     * Get all currently connected (selected) ports
     * Returns array with the selected port, or empty array if none selected
     */
    getConnectedPorts(): string[] {
        return this.selectedPort ? [this.selectedPort] : [];
    }

    /**
     * Get the currently connected board info
     */
    getConnectedBoard(): BoardInfo | null {
        if (this.selectedPort && this.selectedPortInfo) {
            return {
                ...this.selectedPortInfo,
                friendlyName: this.getBoardFriendlyName(this.selectedPortInfo),
                isConnected: true
            };
        }
        return null;
    }

    /**
     * Disconnect from all ports (currently just the selected one)
     */
    async disconnectAll(): Promise<void> {
        if (this.selectedPort) {
            await this.disconnectFromBoard(this.selectedPort);
        }
    }
}