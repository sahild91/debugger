import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { PlatformUtils } from '../utils/platformUtils';
import { DownloadUtils } from '../utils/downloadUtils';

export interface SysConfigSetupProgress {
    stage: 'downloading' | 'extracting' | 'installing' | 'configuring' | 'validating' | 'complete' | 'error';
    progress: number;
    message: string;
}

export interface SysConfigInfo {
    version: string;
    path: string;
    isInstalled: boolean;
    cliPath?: string;
}

export class SysConfigManager {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private sysConfigPath: string;
    private downloadUtils: DownloadUtils;
    
    // TI SysConfig download URLs (v1.24.2.4234)
    private readonly SYSCONFIG_URLS = {
        'win32-x64': 'https://www.ti.com/tool/download/SYSCONFIG/1.24.2.4234/sysconfig_1.24.2.4234_windows-x64_installer.exe',
        'darwin-x64': 'https://www.ti.com/tool/download/SYSCONFIG/1.24.2.4234/sysconfig_1.24.2.4234_osx_installer.dmg',
        'darwin-arm64': 'https://www.ti.com/tool/download/SYSCONFIG/1.24.2.4234/sysconfig_1.24.2.4234_osx_installer.dmg',
        'linux-x64': 'https://www.ti.com/tool/download/SYSCONFIG/1.24.2.4234/sysconfig_1.24.2.4234_linux-x64_installer.run',
        'linux-arm64': 'https://www.ti.com/tool/download/SYSCONFIG/1.24.2.4234/sysconfig_1.24.2.4234_linux-arm64_installer.run'
    };

    private readonly SYSCONFIG_VERSION = '1.24.2.4234';
    private readonly SYSCONFIG_FOLDER_NAME = 'sysconfig-1.24.2';

    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.sysConfigPath = path.join(context.globalStorageUri.fsPath, this.SYSCONFIG_FOLDER_NAME);
        this.downloadUtils = new DownloadUtils(outputChannel);
    }

    async isSysConfigInstalled(): Promise<boolean> {
        try {
            const sysConfigInfo = await this.getSysConfigInfo();
            return sysConfigInfo.isInstalled;
        } catch (error) {
            this.outputChannel.appendLine(`Error checking SysConfig installation: ${error}`);
            return false;
        }
    }

    async getSysConfigInfo(): Promise<SysConfigInfo> {
        const defaultInfo: SysConfigInfo = {
            version: 'Not installed',
            path: this.sysConfigPath,
            isInstalled: false
        };

        try {
            // Search in multiple possible installation locations
            const searchPaths = [
                // Our preferred location (global storage)
                this.sysConfigPath,
                // Common TI installation locations
                'C:\\ti\\sysconfig_1.24.2',
                'C:\\Program Files\\Texas Instruments\\sysconfig_1.24.2',
                'C:\\Program Files (x86)\\Texas Instruments\\sysconfig_1.24.2',
                // macOS locations
                '/Applications/ti/sysconfig_1.24.2',
                '/opt/ti/sysconfig_1.24.2',
                // Linux locations  
                '/opt/ti/sysconfig_1.24.2',
                '/usr/local/ti/sysconfig_1.24.2',
                // User home directory variations
                path.join(os.homedir(), 'ti', 'sysconfig_1.24.2'),
                path.join(os.homedir(), '.ti', 'sysconfig_1.24.2'),
                // Version variations
                'C:\\ti\\sysconfig_1.20.0',
                '/opt/ti/sysconfig_1.20.0'
            ];

            this.outputChannel.appendLine('Searching for SysConfig in multiple locations...');

            for (const searchPath of searchPaths) {
                this.outputChannel.appendLine(`Checking: ${searchPath}`);
                
                if (fs.existsSync(searchPath)) {
                    this.outputChannel.appendLine(`Found directory: ${searchPath}`);
                    
                    const sysConfigInfo = await this.validateSysConfigAtPath(searchPath);
                    if (sysConfigInfo.isInstalled) {
                        this.outputChannel.appendLine(`✅ Valid SysConfig found at: ${searchPath}`);
                        // Update our internal path to the actual location
                        this.sysConfigPath = searchPath;
                        return sysConfigInfo;
                    } else {
                        this.outputChannel.appendLine(`❌ Directory exists but no valid SysConfig found`);
                    }
                } else {
                    this.outputChannel.appendLine(`❌ Directory does not exist`);
                }
            }

            // If not found in standard locations, try to find via registry or environment
            const registryPath = await this.findSysConfigViaRegistry();
            if (registryPath && fs.existsSync(registryPath)) {
                this.outputChannel.appendLine(`Found via registry: ${registryPath}`);
                const sysConfigInfo = await this.validateSysConfigAtPath(registryPath);
                if (sysConfigInfo.isInstalled) {
                    this.sysConfigPath = registryPath;
                    return sysConfigInfo;
                }
            }

            this.outputChannel.appendLine('❌ SysConfig not found in any expected location');
            return defaultInfo;

        } catch (error) {
            this.outputChannel.appendLine(`Error getting SysConfig info: ${error}`);
            return defaultInfo;
        }
    }

    private async validateSysConfigAtPath(sysConfigPath: string): Promise<SysConfigInfo> {
        const defaultInfo: SysConfigInfo = {
            version: 'Not installed',
            path: sysConfigPath,
            isInstalled: false
        };

        try {
            const platform = PlatformUtils.getCurrentPlatform();
            
            // Look for SysConfig CLI executable
            const possibleCliPaths = this.getSysConfigCliPaths(sysConfigPath, platform);

            for (const possiblePath of possibleCliPaths) {
                this.outputChannel.appendLine(`  Checking CLI executable: ${possiblePath}`);
                if (fs.existsSync(possiblePath)) {
                    this.outputChannel.appendLine(`  ✅ Found SysConfig CLI: ${possiblePath}`);
                    
                    // Try to get version information
                    const version = await this.getSysConfigVersion(possiblePath);

                    return {
                        version,
                        path: sysConfigPath,
                        isInstalled: true,
                        cliPath: possiblePath
                    };
                } else {
                    this.outputChannel.appendLine(`  ❌ Not found: ${possiblePath}`);
                }
            }

            return defaultInfo;
        } catch (error) {
            this.outputChannel.appendLine(`Error validating SysConfig at ${sysConfigPath}: ${error}`);
            return defaultInfo;
        }
    }

    private getSysConfigCliPaths(sysConfigRoot: string, platform: string): string[] {
        const paths: string[] = [];

        if (platform.startsWith('win32')) {
            // Windows paths
            paths.push(
                path.join(sysConfigRoot, 'sysconfig_cli.bat'),
                path.join(sysConfigRoot, 'bin', 'sysconfig_cli.bat'),
                path.join(sysConfigRoot, 'sysconfig.bat'),
                path.join(sysConfigRoot, 'nodejs', 'sysconfig_cli.bat')
            );
        } else {
            // Unix-like systems (Linux/macOS)
            paths.push(
                path.join(sysConfigRoot, 'sysconfig_cli.sh'),
                path.join(sysConfigRoot, 'bin', 'sysconfig_cli.sh'),
                path.join(sysConfigRoot, 'sysconfig.sh'),
                path.join(sysConfigRoot, 'nodejs', 'sysconfig_cli.sh')
            );
        }

        return paths;
    }

    private async getSysConfigVersion(cliPath: string): Promise<string> {
        try {
            const { spawn } = require('child_process');
            
            return new Promise((resolve) => {
                // Try to get version using --version flag
                const process = spawn(cliPath, ['--version'], {
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                let output = '';
                
                process.stdout.on('data', (data: any) => {
                    output += data.toString();
                });

                process.stderr.on('data', (data: any) => {
                    output += data.toString();
                });

                process.on('close', (code: number) => {
                    if (code === 0 && output) {
                        // Parse version from output
                        const versionMatch = output.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
                        resolve(versionMatch ? versionMatch[1] : this.SYSCONFIG_VERSION);
                    } else {
                        // Fallback to expected version
                        resolve(this.SYSCONFIG_VERSION);
                    }
                });

                process.on('error', () => {
                    resolve('Unknown');
                });

                // Set timeout
                setTimeout(() => {
                    process.kill();
                    resolve('Unknown');
                }, 5000);
            });
        } catch (error) {
            this.outputChannel.appendLine(`Error getting SysConfig version: ${error}`);
            return 'Unknown';
        }
    }

    private async findSysConfigViaRegistry(): Promise<string | null> {
        // Try to find SysConfig installation via Windows registry
        if (process.platform !== 'win32') {
            return null;
        }

        try {
            const { exec } = require('child_process');
            
            return new Promise((resolve) => {
                // Query registry for TI SysConfig installation paths
                const regQuery = 'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Texas Instruments" /s /f "sysconfig" 2>nul';
                
                exec(regQuery, (error: any, stdout: string, stderr: any) => {
                    if (error || !stdout) {
                        this.outputChannel.appendLine('No SysConfig registry entries found');
                        resolve(null);
                        return;
                    }

                    // Parse registry output to find installation path
                    const lines = stdout.split('\n');
                    for (const line of lines) {
                        if (line.includes('sysconfig') && line.includes('1.2')) {
                            // Extract path from registry line
                            const pathMatch = line.match(/([C-Z]:\\[^"]*sysconfig[^"]*)/i);
                            if (pathMatch) {
                                this.outputChannel.appendLine(`Found SysConfig registry path: ${pathMatch[1]}`);
                                resolve(pathMatch[1]);
                                return;
                            }
                        }
                    }
                    resolve(null);
                });
            });
        } catch (error) {
            this.outputChannel.appendLine(`SysConfig registry search failed: ${error}`);
            return null;
        }
    }

    async installSysConfig(progressCallback?: (progress: SysConfigSetupProgress) => void): Promise<void> {
        let downloadPath: string | undefined;
        
        try {
            // Check if already installed
            if (await this.isSysConfigInstalled()) {
                progressCallback?.({
                    stage: 'complete',
                    progress: 100,
                    message: 'SysConfig already installed'
                });
                return;
            }

            const platform = PlatformUtils.getCurrentPlatform();
            const downloadUrl = this.SYSCONFIG_URLS[platform as keyof typeof this.SYSCONFIG_URLS];

            if (!downloadUrl) {
                throw new Error(`Unsupported platform for SysConfig installation: ${platform}`);
            }

            progressCallback?.({
                stage: 'downloading',
                progress: 5,
                message: 'Starting SysConfig download...'
            });

            // Ensure global storage directory exists
            if (!fs.existsSync(this.context.globalStorageUri.fsPath)) {
                fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
            }

            this.outputChannel.appendLine(`Downloading TI SysConfig for ${platform}`);
            this.outputChannel.appendLine(`URL: ${downloadUrl}`);

            // Download SysConfig installer
            const fileName = this.getInstallerFileName(downloadUrl);
            downloadPath = path.join(os.tmpdir(), `sysconfig-${Date.now()}-${fileName}`);
            
            await this.downloadUtils.downloadFile(downloadUrl, downloadPath, (progress) => {
                progressCallback?.({
                    stage: 'downloading',
                    progress: 5 + (progress * 0.6), // 5-65%
                    message: `Downloading SysConfig... ${progress.toFixed(1)}%`
                });
            });

            progressCallback?.({
                stage: 'installing',
                progress: 70,
                message: 'Installing SysConfig...'
            });

            // Handle different installer types based on platform
            await this.installSysConfigFromFile(downloadPath, platform);

            progressCallback?.({
                stage: 'configuring',
                progress: 85,
                message: 'Configuring SysConfig...'
            });

            // Set up executable permissions on Unix systems
            if (process.platform !== 'win32') {
                await this.setupExecutablePermissions();
            }

            progressCallback?.({
                stage: 'validating',
                progress: 95,
                message: 'Validating installation...'
            });

            // Validate the installation
            const sysConfigInfo = await this.getSysConfigInfo();
            if (!sysConfigInfo.isInstalled) {
                throw new Error('SysConfig validation failed after installation');
            }

            // Clean up download file on success
            if (downloadPath && fs.existsSync(downloadPath)) {
                try {
                    fs.unlinkSync(downloadPath);
                } catch (cleanupError) {
                    this.outputChannel.appendLine(`Warning: Could not clean up download file: ${cleanupError}`);
                }
            }

            this.outputChannel.appendLine(`TI SysConfig installed successfully. Version: ${sysConfigInfo.version}`);

            progressCallback?.({
                stage: 'complete',
                progress: 100,
                message: `SysConfig installation complete. Version: ${sysConfigInfo.version}`
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`SysConfig installation failed: ${errorMessage}`);
            
            progressCallback?.({
                stage: 'error',
                progress: 0,
                message: `Installation failed: ${errorMessage}`
            });

            // Clean up download file on error
            if (downloadPath && fs.existsSync(downloadPath)) {
                try {
                    fs.unlinkSync(downloadPath);
                    this.outputChannel.appendLine('Cleaned up downloaded installer file');
                } catch (cleanupError) {
                    this.outputChannel.appendLine(`Warning: Could not clean up download file: ${cleanupError}`);
                }
            }

            // Clean up installation directory on failure
            if (fs.existsSync(this.sysConfigPath)) {
                try {
                    fs.rmSync(this.sysConfigPath, { recursive: true, force: true });
                    this.outputChannel.appendLine('Cleaned up partial installation directory');
                } catch (cleanupError) {
                    this.outputChannel.appendLine(`SysConfig cleanup failed: ${cleanupError}`);
                }
            }

            throw error;
        }
    }

    private getInstallerFileName(url: string): string {
        const urlParts = url.split('/');
        return urlParts[urlParts.length - 1];
    }

    private async installSysConfigFromFile(installerPath: string, platform: string): Promise<void> {
        const { spawn } = require('child_process');
        
        return new Promise((resolve, reject) => {
            // Ensure install directory exists
            if (!fs.existsSync(this.sysConfigPath)) {
                fs.mkdirSync(this.sysConfigPath, { recursive: true });
            }

            let installCommand: string;
            let installArgs: string[];

            // Platform-specific installation commands
            if (platform.startsWith('win32')) {
                // Windows: Silent install with custom directory
                installCommand = installerPath;
                installArgs = [
                    '/S',  // Silent installation
                    `/D=${this.sysConfigPath}` // Custom install directory
                ];
            } else if (platform.startsWith('darwin')) {
                // macOS: Extract DMG and copy contents
                installCommand = 'hdiutil';
                installArgs = [
                    'attach',
                    installerPath,
                    '-nobrowse'
                ];
                // Note: macOS installation is more complex, requires DMG mounting
            } else {
                // Linux: Run installer with custom prefix
                installCommand = 'sh';
                installArgs = [
                    installerPath,
                    '--mode', 'unattended',
                    '--prefix', this.sysConfigPath
                ];
            }

            if (!installCommand) {
                reject(new Error(`Unsupported platform for SysConfig installation: ${platform}`));
                return;
            }

            this.outputChannel.appendLine(`SysConfig install command: ${installCommand} ${installArgs.join(' ')}`);

            // Execute installation
            const installProcess = spawn(installCommand, installArgs, {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            installProcess.stdout.on('data', (data: { toString: () => any; }) => {
                const output = data.toString();
                stdout += output;
                this.outputChannel.append(output);
            });

            installProcess.stderr.on('data', (data: { toString: () => any; }) => {
                const output = data.toString();
                stderr += output;
                this.outputChannel.append(output);
            });

            installProcess.on('close', (code: number) => {
                if (code === 0) {
                    this.outputChannel.appendLine('SysConfig installation completed');
                    resolve();
                } else {
                    const error = `SysConfig installation failed with exit code ${code}. Output: ${stderr}`;
                    this.outputChannel.appendLine(error);
                    reject(new Error(error));
                }
            });

            installProcess.on('error', (error: { message: any; }) => {
                const errorMessage = `SysConfig installation process error: ${error.message}`;
                this.outputChannel.appendLine(errorMessage);
                reject(new Error(errorMessage));
            });

            // Set timeout for installation
            setTimeout(() => {
                installProcess.kill();
                reject(new Error('SysConfig installation timed out'));
            }, 300000); // 5 minutes timeout
        });
    }

    private async setupExecutablePermissions(): Promise<void> {
        try {
            const { exec } = require('child_process');
            const cliPath = this.getSysConfigCliPath();
            
            if (fs.existsSync(cliPath)) {
                await new Promise((resolve, reject) => {
                    exec(`chmod +x "${cliPath}"`, (error: any) => {
                        if (error) {
                            this.outputChannel.appendLine(`Warning: Could not set execute permission: ${error}`);
                        } else {
                            this.outputChannel.appendLine('Execute permissions set for SysConfig CLI');
                        }
                        resolve(undefined);
                    });
                });
            }
        } catch (error) {
            this.outputChannel.appendLine(`Error setting up executable permissions: ${error}`);
        }
    }

    getSysConfigPath(): string {
        return this.sysConfigPath;
    }

    getSysConfigCliPath(): string {
        const platform = PlatformUtils.getCurrentPlatform();
        const possiblePaths = this.getSysConfigCliPaths(this.sysConfigPath, platform);
        
        // Return the first existing path
        for (const path of possiblePaths) {
            if (fs.existsSync(path)) {
                return path;
            }
        }
        
        // Return the most likely path even if it doesn't exist
        return possiblePaths[0];
    }

    async validateSysConfigForBuild(): Promise<boolean> {
        try {
            const cliPath = this.getSysConfigCliPath();
            
            if (!fs.existsSync(cliPath)) {
                this.outputChannel.appendLine(`SysConfig CLI not found at: ${cliPath}`);
                return false;
            }

            // Test if CLI is executable
            const { spawn } = require('child_process');
            
            return new Promise((resolve) => {
                const testProcess = spawn(cliPath, ['--help'], {
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                testProcess.on('close', (code: number) => {
                    resolve(code === 0);
                });

                testProcess.on('error', () => {
                    resolve(false);
                });

                setTimeout(() => {
                    testProcess.kill();
                    resolve(false);
                }, 5000);
            });
        } catch (error) {
            this.outputChannel.appendLine(`Error validating SysConfig for build: ${error}`);
            return false;
        }
    }

    // Method to set custom SysConfig installation path (for testing or manual installations)
    setSysConfigPath(customPath: string): void {
        if (fs.existsSync(customPath)) {
            this.sysConfigPath = customPath;
            this.outputChannel.appendLine(`SysConfig path updated to: ${customPath}`);
        } else {
            throw new Error(`SysConfig path does not exist: ${customPath}`);
        }
    }

    async uninstallSysConfig(): Promise<void> {
        try {
            if (fs.existsSync(this.sysConfigPath)) {
                this.outputChannel.appendLine(`Uninstalling SysConfig from: ${this.sysConfigPath}`);
                fs.rmSync(this.sysConfigPath, { recursive: true, force: true });
                this.outputChannel.appendLine('SysConfig uninstalled successfully');
            } else {
                this.outputChannel.appendLine('SysConfig not found for uninstallation');
            }
        } catch (error) {
            this.outputChannel.appendLine(`Error uninstalling SysConfig: ${error}`);
            throw error;
        }
    }
}