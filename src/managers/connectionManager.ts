import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface SerialPort {
    path: string;
    manufacturer?: string;
    serialNumber?: string;
    vendorId?: string;
    productId?: string;
    deviceType?: 'ESP32' | 'Arduino' | 'MCP' | 'Unknown';
}

export class ConnectionManager {
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
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
            this.outputChannel.appendLine(`❌ Error getting ports: ${error}`);
            throw error;
        }
    }

    private async getMacPorts(): Promise<SerialPort[]> {
        const ports: SerialPort[] = [];

        // Get basic port list
        try {
            const { stdout } = await execAsync('ls /dev/cu.* 2>/dev/null || true');
            const portPaths = stdout.trim().split('\n').filter(path =>
                path.includes('usbserial') || path.includes('usbmodem')
            );

            // Get USB device info for VID/PID
            const { stdout: usbInfo } = await execAsync('system_profiler SPUSBDataType 2>/dev/null || echo ""');

            for (const portPath of portPaths) {
                const port: SerialPort = {
                    path: portPath,
                    deviceType: 'Unknown'
                };

                // Try to extract device info from system_profiler output
                const deviceInfo = this.parseUSBInfo(usbInfo, portPath);
                if (deviceInfo) {
                    port.manufacturer = deviceInfo.manufacturer;
                    port.serialNumber = deviceInfo.serialNumber;
                    port.vendorId = deviceInfo.vendorId;
                    port.productId = deviceInfo.productId;
                    port.deviceType = this.identifyDeviceType(deviceInfo.vendorId, deviceInfo.productId);
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
            // Use PowerShell to get COM port information with VID/PID
            const command = `powershell -Command "Get-WmiObject -Class Win32_PnPEntity | Where-Object { $_.Caption -match 'COM[0-9]+' } | ForEach-Object { $_.Caption + '|' + $_.DeviceID + '|' + $_.Manufacturer }"`;
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

    private identifyDeviceType(vendorId?: string, productId?: string): 'ESP32' | 'Arduino' | 'MCP' | 'Unknown' {
        if (!vendorId) return 'Unknown';

        const vid = vendorId.toUpperCase();

        // Common VID/PID combinations
        const deviceMap: { [key: string]: 'ESP32' | 'Arduino' | 'MCP' } = {
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
                const selectedPort = selected.port;
                const deviceInfo = [
                    `Port: ${selectedPort.path}`,
                    selectedPort.deviceType !== 'Unknown' && `Type: ${selectedPort.deviceType}`,
                    selectedPort.manufacturer && `Manufacturer: ${selectedPort.manufacturer}`,
                    selectedPort.vendorId && selectedPort.productId && `VID:PID ${selectedPort.vendorId}:${selectedPort.productId}`
                ].filter(Boolean).join('\n');

                vscode.window.showInformationMessage(`Connected to:\n${deviceInfo}`);
                this.outputChannel.appendLine(`🔌 Connected to port: ${selectedPort.path}`);

                if (selectedPort.deviceType !== 'Unknown') {
                    this.outputChannel.appendLine(`📱 Device type: ${selectedPort.deviceType}`);
                }

                return selectedPort.path;
            }

            return undefined;
        } catch (error) {
            const errorMessage = `Failed to get available ports: ${error}`;
            vscode.window.showErrorMessage(errorMessage);
            this.outputChannel.appendLine(`❌ ${errorMessage}`);
            return undefined;
        }
    }
}