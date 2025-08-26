import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { PlatformUtils } from '../utils/platformUtils';
import { DownloadUtils } from '../utils/downloadUtils';

export interface ToolchainSetupProgress {
    stage: 'downloading' | 'extracting' | 'configuring' | 'validating' | 'complete' | 'error';
    progress: number;
    message: string;
}

export interface ToolchainInfo {
    version: string;
    path: string;
    isInstalled: boolean;
    executablePath?: string;
}

export class ToolchainManager {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private toolchainPath: string;
    private downloadUtils: DownloadUtils;
    
    // TI ARM-CGT-CLANG toolchain download URLs (v4.0.3.LTS)
    private readonly TOOLCHAIN_URLS = {
        'win32-x64': 'https://dr-download.ti.com/software-development/ide-configuration-compiler-or-debugger/MD-ayxs93eZNN/4.0.3.LTS/ti_cgt_armllvm_4.0.3.LTS_windows-x64_installer.exe',
        'darwin-x64': 'https://dr-download.ti.com/software-development/ide-configuration-compiler-or-debugger/MD-ayxs93eZNN/4.0.3.LTS/ti_cgt_armllvm_4.0.3.LTS_osx_installer.app.zip',
        'darwin-arm64': 'https://dr-download.ti.com/software-development/ide-configuration-compiler-or-debugger/MD-ayxs93eZNN/4.0.3.LTS/ti_cgt_armllvm_4.0.3.LTS_osx_installer.app.zip',
        'linux-x64': 'https://dr-download.ti.com/software-development/ide-configuration-compiler-or-debugger/MD-ayxs93eZNN/4.0.3.LTS/ti_cgt_armllvm_4.0.3.LTS_linux-x64_installer.bin',
        'linux-arm64': 'https://dr-download.ti.com/software-development/ide-configuration-compiler-or-debugger/MD-ayxs93eZNN/4.0.3.LTS/ti_cgt_armllvm_4.0.3.LTS_linux-arm64_installer.bin'
    };

    private readonly TOOLCHAIN_FOLDER_NAME = 'ti-cgt-armllvm-4.0.3';

    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.toolchainPath = path.join(context.globalStorageUri.fsPath, this.TOOLCHAIN_FOLDER_NAME);
        this.downloadUtils = new DownloadUtils(outputChannel);
    }

    async isToolchainInstalled(): Promise<boolean> {
        try {
            const toolchainInfo = await this.getToolchainInfo();
            return toolchainInfo.isInstalled;
        } catch (error) {
            this.outputChannel.appendLine(`Error checking toolchain installation: ${error}`);
            return false;
        }
    }

    async getToolchainInfo(): Promise<ToolchainInfo> {
        const defaultInfo: ToolchainInfo = {
            version: 'Not installed',
            path: this.toolchainPath,
            isInstalled: false
        };

        try {
            // Search in multiple possible installation locations
            const searchPaths = [
                // Our preferred location
                this.toolchainPath,
                // Common TI installation locations
                'C:\\ti\\ccs\\tools\\compiler\\ti-cgt-armllvm_4.0.3.LTS',
                'C:\\ti\\ti-cgt-armllvm_4.0.3.LTS',
                'C:\\Program Files\\Texas Instruments\\ti-cgt-armllvm_4.0.3.LTS',
                'C:\\Program Files (x86)\\Texas Instruments\\ti-cgt-armllvm_4.0.3.LTS',
                // User's home directory variations  
                path.join(os.homedir(), 'ti', 'ti-cgt-armllvm_4.0.3.LTS'),
                path.join(os.homedir(), 'AppData', 'Local', 'ti', 'ti-cgt-armllvm_4.0.3.LTS'),
                // Version variations
                'C:\\ti\\ccs\\tools\\compiler\\ti-cgt-armllvm_4.0.3',
                'C:\\ti\\ti-cgt-armllvm_4.0.3'
            ];

            this.outputChannel.appendLine('Searching for toolchain in multiple locations...');

            for (const searchPath of searchPaths) {
                this.outputChannel.appendLine(`Checking: ${searchPath}`);
                
                if (fs.existsSync(searchPath)) {
                    this.outputChannel.appendLine(`Found directory: ${searchPath}`);
                    
                    const toolchainInfo = await this.validateToolchainAtPath(searchPath);
                    if (toolchainInfo.isInstalled) {
                        this.outputChannel.appendLine(`✅ Valid toolchain found at: ${searchPath}`);
                        // Update our internal path to the actual location
                        this.toolchainPath = searchPath;
                        return toolchainInfo;
                    } else {
                        this.outputChannel.appendLine(`❌ Directory exists but no valid toolchain found`);
                    }
                } else {
                    this.outputChannel.appendLine(`❌ Directory does not exist`);
                }
            }

            // If not found in standard locations, try to find via registry or environment
            const registryPath = await this.findToolchainViaRegistry();
            if (registryPath && fs.existsSync(registryPath)) {
                this.outputChannel.appendLine(`Found via registry: ${registryPath}`);
                const toolchainInfo = await this.validateToolchainAtPath(registryPath);
                if (toolchainInfo.isInstalled) {
                    this.toolchainPath = registryPath;
                    return toolchainInfo;
                }
            }

            this.outputChannel.appendLine('❌ Toolchain not found in any expected location');
            return defaultInfo;

        } catch (error) {
            this.outputChannel.appendLine(`Error getting toolchain info: ${error}`);
            return defaultInfo;
        }
    }

    private async validateToolchainAtPath(toolchainPath: string): Promise<ToolchainInfo> {
        const defaultInfo: ToolchainInfo = {
            version: 'Not installed',
            path: toolchainPath,
            isInstalled: false
        };

        try {
            const platform = PlatformUtils.getCurrentPlatform();
            const executableName = platform.startsWith('win32') ? 'tiarmclang.exe' : 'tiarmclang';
            
            // Search in common subdirectories for v4.0.3
            const possiblePaths = [
                path.join(toolchainPath, 'bin', executableName),
                path.join(toolchainPath, 'ti-cgt-armllvm_4.0.3.LTS', 'bin', executableName),
                path.join(toolchainPath, 'ccs', 'tools', 'compiler', 'ti-cgt-armllvm_4.0.3.LTS', 'bin', executableName),
                path.join(toolchainPath, executableName)
            ];

            for (const possiblePath of possiblePaths) {
                this.outputChannel.appendLine(`  Checking executable: ${possiblePath}`);
                if (fs.existsSync(possiblePath)) {
                    this.outputChannel.appendLine(`  ✅ Found compiler executable: ${possiblePath}`);
                    
                    // Try to get version information
                    const version = await this.getToolchainVersion(possiblePath);

                    return {
                        version,
                        path: toolchainPath,
                        isInstalled: true,
                        executablePath: possiblePath
                    };
                } else {
                    this.outputChannel.appendLine(`  ❌ Not found: ${possiblePath}`);
                }
            }

            return defaultInfo;
        } catch (error) {
            this.outputChannel.appendLine(`Error validating toolchain at ${toolchainPath}: ${error}`);
            return defaultInfo;
        }
    }

    private async findToolchainViaRegistry(): Promise<string | null> {
        // Try to find TI tools installation via Windows registry
        if (process.platform !== 'win32') {
            return null;
        }

        try {
            const { exec } = require('child_process');
            
            return new Promise((resolve) => {
                // Query registry for TI installation paths
                const regQuery = 'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Texas Instruments" /s /f "ti-cgt-armllvm" 2>nul';
                
                exec(regQuery, (error: any, stdout: string, stderr: any) => {
                    if (error || !stdout) {
                        this.outputChannel.appendLine('No TI registry entries found');
                        resolve(null);
                        return;
                    }

                    // Parse registry output to find installation path
                    const lines = stdout.split('\n');
                    for (const line of lines) {
                        if (line.includes('ti-cgt-armllvm') && line.includes('4.0.3')) {
                            // Extract path from registry line
                            const pathMatch = line.match(/([C-Z]:\\[^"]*ti-cgt-armllvm[^"]*)/i);
                            if (pathMatch) {
                                this.outputChannel.appendLine(`Found registry path: ${pathMatch[1]}`);
                                resolve(pathMatch[1]);
                                return;
                            }
                        }
                    }
                    resolve(null);
                });
            });
        } catch (error) {
            this.outputChannel.appendLine(`Registry search failed: ${error}`);
            return null;
        }
    }

    async installToolchain(progressCallback?: (progress: ToolchainSetupProgress) => void): Promise<void> {
        let downloadPath: string | undefined;
        
        try {
            // Check if already installed
            if (await this.isToolchainInstalled()) {
                progressCallback?.({
                    stage: 'complete',
                    progress: 100,
                    message: 'Toolchain already installed'
                });
                return;
            }

            const platform = PlatformUtils.getCurrentPlatform();
            const downloadUrl = this.TOOLCHAIN_URLS[platform as keyof typeof this.TOOLCHAIN_URLS];

            if (!downloadUrl) {
                throw new Error(`Unsupported platform: ${platform}`);
            }

            progressCallback?.({
                stage: 'downloading',
                progress: 5,
                message: 'Starting toolchain download...'
            });

            // Ensure global storage directory exists
            if (!fs.existsSync(this.context.globalStorageUri.fsPath)) {
                fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
            }

            this.outputChannel.appendLine(`Downloading ARM-CGT-CLANG toolchain for ${platform}`);
            this.outputChannel.appendLine(`URL: ${downloadUrl}`);

            // Download the toolchain
            const fileName = this.getInstallerFileName(downloadUrl);
            downloadPath = path.join(os.tmpdir(), `toolchain-${Date.now()}-${fileName}`);
            
            await this.downloadUtils.downloadFile(downloadUrl, downloadPath, (progress) => {
                progressCallback?.({
                    stage: 'downloading',
                    progress: 5 + (progress * 0.6), // 5-65%
                    message: `Downloading toolchain... ${progress.toFixed(1)}%`
                });
            });

            progressCallback?.({
                stage: 'extracting',
                progress: 70,
                message: 'Installing toolchain...'
            });

            // Handle different installer types based on platform
            await this.installToolchainFromFile(downloadPath, platform);

            progressCallback?.({
                stage: 'configuring',
                progress: 85,
                message: 'Configuring toolchain...'
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
            const toolchainInfo = await this.getToolchainInfo();
            if (!toolchainInfo.isInstalled) {
                throw new Error('Toolchain validation failed after installation');
            }

            // Clean up download file on success
            if (downloadPath && fs.existsSync(downloadPath)) {
                try {
                    fs.unlinkSync(downloadPath);
                } catch (cleanupError) {
                    this.outputChannel.appendLine(`Warning: Could not clean up download file: ${cleanupError}`);
                }
            }

            this.outputChannel.appendLine(`ARM-CGT-CLANG toolchain installed successfully. Version: ${toolchainInfo.version}`);

            progressCallback?.({
                stage: 'complete',
                progress: 100,
                message: `Toolchain installation complete. Version: ${toolchainInfo.version}`
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Toolchain installation failed: ${errorMessage}`);
            
            // Complete the error progress callback
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
            if (fs.existsSync(this.toolchainPath)) {
                try {
                    fs.rmSync(this.toolchainPath, { recursive: true, force: true });
                    this.outputChannel.appendLine('Cleaned up partial installation directory');
                } catch (cleanupError) {
                    this.outputChannel.appendLine(`Cleanup failed: ${cleanupError}`);
                }
            }

            throw error;
        }
    }

    private getInstallerFileName(url: string): string {
        const urlParts = url.split('/');
        return urlParts[urlParts.length - 1];
    }

    private async installToolchainFromFile(installerPath: string, platform: string): Promise<void> {
        const { spawn } = require('child_process');
        
        return new Promise((resolve, reject) => {
            // Ensure install directory exists
            if (!fs.existsSync(this.toolchainPath)) {
                fs.mkdirSync(this.toolchainPath, { recursive: true });
            }

            let installCommand: string;
            let installArgs: string[];

            if (platform.startsWith('win32')) {
                // Windows installer (.exe)
                this.outputChannel.appendLine('Running Windows installer...');
                installCommand = installerPath;
                installArgs = [
                    '--mode unattended', // Silent installation
                    `--prefix ${this.toolchainPath}` // Installation directory
                ];
            } else if (platform.startsWith('darwin')) {
                // macOS installer (.app.zip)
                this.outputChannel.appendLine('Extracting and running macOS installer...');
                
                // First extract the .app.zip
                installCommand = 'unzip';
                installArgs = ['-q', '-o', installerPath, '-d', path.dirname(installerPath)];
                
                // Note: This is simplified - macOS .app installers often need additional handling
            } else if (platform.startsWith('linux')) {
                // Linux installer (.bin)
                this.outputChannel.appendLine('Running Linux installer...');
                
                // Make installer executable
                fs.chmodSync(installerPath, '755');
                
                installCommand = installerPath;
                installArgs = [
                    '--mode', 'silent',
                    '--prefix', this.toolchainPath
                ];
            } else {
                reject(new Error(`Unsupported platform for installation: ${platform}`));
                return;
            }

            this.outputChannel.appendLine(`Install command: ${installCommand} ${installArgs.join(' ')}`);

            // Additional Windows-specific preparation
            if (platform.startsWith('win32')) {
                // Check if file exists and is accessible
                try {
                    const stats = fs.statSync(installerPath);
                    this.outputChannel.appendLine(`Installer file size: ${stats.size} bytes`);
                    this.outputChannel.appendLine(`Installer file permissions: ${stats.mode}`);
                } catch (error) {
                    reject(new Error(`Cannot access installer file: ${error}`));
                    return;
                }

                // Wait a moment to ensure file isn't locked
                this.outputChannel.appendLine('Waiting for file to be ready...');
                setTimeout(() => {
                    this.executeInstaller(installCommand, installArgs, resolve, reject, platform);
                }, 2000);
            } else {
                this.executeInstaller(installCommand, installArgs, resolve, reject, platform);
            }
        });
    }

    private executeInstaller(
        command: string, 
        args: string[], 
        resolve: Function, 
        reject: Function, 
        platform: string
    ): void {
        const { spawn } = require('child_process');

        // Try different execution methods for Windows
        const executionMethods = platform.startsWith('win32') 
            ? [
                { name: 'Direct execution', useShell: false },
                { name: 'Shell execution', useShell: true },
                { name: 'PowerShell execution', usePowerShell: true }
            ]
            : [{ name: 'Direct execution', useShell: false }];

        let currentMethod = 0;

        const tryNextMethod = () => {
            if (currentMethod >= executionMethods.length) {
                reject(new Error('All execution methods failed'));
                return;
            }

            const method = executionMethods[currentMethod];
            this.outputChannel.appendLine(`Attempting: ${method.name}`);
            currentMethod++;

            let installProcess: { stdout: { on: (arg0: string, arg1: (data: any) => void) => void; }; stderr: { on: (arg0: string, arg1: (data: any) => void) => void; }; on: (arg0: string, arg1: { (code: any): void; (error: any): void; }) => void; killed: any; kill: () => void; };

            try {
                if (method.usePowerShell) {
                    // Use PowerShell as a fallback for Windows
                    const psCommand = `Start-Process "${command}" -ArgumentList "${args.join('","')}" -Wait -PassThru`;
                    installProcess = spawn('powershell', ['-Command', psCommand], {
                        stdio: ['pipe', 'pipe', 'pipe']
                    });
                } else {
                    installProcess = spawn(command, args, {
                        stdio: ['pipe', 'pipe', 'pipe'],
                        shell: method.useShell
                    });
                }

                let stdout = '';
                let stderr = '';

                installProcess.stdout?.on('data', (data) => {
                    const output = data.toString();
                    stdout += output;
                    this.outputChannel.append(output);
                });

                installProcess.stderr?.on('data', (data) => {
                    const output = data.toString();
                    stderr += output;
                    this.outputChannel.append(output);
                });

                installProcess.on('close', (code) => {
                    if (code === 0) {
                        this.outputChannel.appendLine(`${method.name} completed successfully`);
                        resolve();
                    } else {
                        this.outputChannel.appendLine(`${method.name} failed with exit code ${code}`);
                        this.outputChannel.appendLine(`stderr: ${stderr}`);
                        tryNextMethod();
                    }
                });

                installProcess.on('error', (error) => {
                    this.outputChannel.appendLine(`${method.name} process error: ${error.message}`);
                    
                    if (error.message.includes('EBUSY')) {
                        this.outputChannel.appendLine('File appears to be locked or in use by another process');
                        this.outputChannel.appendLine('This might be caused by antivirus software or Windows Defender');
                        this.outputChannel.appendLine('Try adding exclusions for the temp and extension directories');
                    }
                    
                    tryNextMethod();
                });

                // Set timeout for installation (15 minutes)
                setTimeout(() => {
                    if (installProcess && !installProcess.killed) {
                        installProcess.kill();
                        this.outputChannel.appendLine(`${method.name} timed out`);
                        tryNextMethod();
                    }
                }, 900000);

            } catch (spawnError) {
                this.outputChannel.appendLine(`${method.name} spawn failed: ${spawnError}`);
                tryNextMethod();
            }
        };

        tryNextMethod();
    }

    private async extractToolchain(archivePath: string, extractPath: string): Promise<void> {
        // This method is now primarily for fallback/legacy support
        const { spawn } = require('child_process');
        
        return new Promise((resolve, reject) => {
            // Ensure extract directory exists
            if (!fs.existsSync(extractPath)) {
                fs.mkdirSync(extractPath, { recursive: true });
            }

            let extractCommand: string;
            let extractArgs: string[];

            if (archivePath.endsWith('.zip')) {
                // Windows zip extraction
                if (process.platform === 'win32') {
                    extractCommand = 'powershell';
                    extractArgs = ['-Command', `Expand-Archive -Path "${archivePath}" -DestinationPath "${extractPath}" -Force`];
                } else {
                    extractCommand = 'unzip';
                    extractArgs = ['-q', '-o', archivePath, '-d', extractPath];
                }
            } else {
                // tar.gz extraction
                extractCommand = 'tar';
                extractArgs = ['-xzf', archivePath, '-C', extractPath];
            }

            const extractProcess = spawn(extractCommand, extractArgs);
            
            extractProcess.on('close', (code: any) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Extraction failed with code ${code}`));
                }
            });

            extractProcess.on('error', (error: any) => {
                reject(error);
            });
        });
    }

    private async setupExecutablePermissions(): Promise<void> {
        const { spawn } = require('child_process');
        
        return new Promise((resolve, reject) => {
            // Find all files in the bin directory and make them executable
            const binPath = path.join(this.toolchainPath, '**', 'bin');
            const chmodProcess = spawn('find', [this.toolchainPath, '-name', 'bin', '-type', 'd', '-exec', 'chmod', '+x', '{}/*', ';']);
            
            chmodProcess.on('close', (code: any) => {
                resolve(); // Don't fail on chmod errors, just continue
            });

            chmodProcess.on('error', (error: any) => {
                this.outputChannel.appendLine(`Warning: Could not set executable permissions: ${error}`);
                resolve(); // Continue anyway
            });
        });
    }

    private async getToolchainVersion(executablePath: string): Promise<string> {
        const { spawn } = require('child_process');
        
        return new Promise((resolve) => {
            const versionProcess = spawn(executablePath, ['--version']);
            let output = '';

            versionProcess.stdout.on('data', (data: Buffer) => {
                output += data.toString();
            });

            versionProcess.on('close', () => {
                // Parse version from output
                const versionMatch = output.match(/version\s+(\d+\.\d+\.\d+)/i);
                if (versionMatch) {
                    resolve(versionMatch[1]);
                } else {
                    resolve('Unknown');
                }
            });

            versionProcess.on('error', () => {
                resolve('Unknown');
            });

            // Timeout after 5 seconds
            setTimeout(() => {
                versionProcess.kill();
                resolve('Unknown');
            }, 5000);
        });
    }

    getCompilerPath(): string | undefined {
        try {
            const toolchainInfo = this.getToolchainInfoSync();
            return toolchainInfo.executablePath;
        } catch (error) {
            this.outputChannel.appendLine(`Error getting compiler path: ${error}`);
            return undefined;
        }
    }

    private getToolchainInfoSync(): ToolchainInfo {
        const defaultInfo: ToolchainInfo = {
            version: 'Not installed',
            path: this.toolchainPath,
            isInstalled: false
        };

        try {
            if (!fs.existsSync(this.toolchainPath)) {
                return defaultInfo;
            }

            const platform = PlatformUtils.getCurrentPlatform();
            const executableName = platform.startsWith('win32') ? 'tiarmclang.exe' : 'tiarmclang';
            
            const possiblePaths = [
                path.join(this.toolchainPath, 'bin', executableName),
                path.join(this.toolchainPath, 'ti_cgt_armllvm_3.2.2.LTS', 'bin', executableName),
                path.join(this.toolchainPath, executableName)
            ];

            for (const possiblePath of possiblePaths) {
                if (fs.existsSync(possiblePath)) {
                    return {
                        version: 'Installed',
                        path: this.toolchainPath,
                        isInstalled: true,
                        executablePath: possiblePath
                    };
                }
            }

            return defaultInfo;
        } catch (error) {
            return defaultInfo;
        }
    }

    getToolchainPath(): string {
        return this.toolchainPath;
    }

    getLibraryPaths(): string[] {
        if (!fs.existsSync(this.toolchainPath)) {
            return [];
        }

        // Common library paths for ARM-CGT-CLANG v4.0.3
        const possibleLibPaths = [
            path.join(this.toolchainPath, 'lib'),
            path.join(this.toolchainPath, 'ti-cgt-armllvm_4.0.3.LTS', 'lib'),
            path.join(this.toolchainPath, 'ccs', 'tools', 'compiler', 'ti-cgt-armllvm_4.0.3.LTS', 'lib'),
            path.join(this.toolchainPath, 'armcl', 'lib')
        ];

        return possibleLibPaths.filter(p => fs.existsSync(p));
    }

    getIncludePaths(): string[] {
        if (!fs.existsSync(this.toolchainPath)) {
            return [];
        }

        // Common include paths for ARM-CGT-CLANG v4.0.3
        const possibleIncludePaths = [
            path.join(this.toolchainPath, 'include'),
            path.join(this.toolchainPath, 'ti-cgt-armllvm_4.0.3.LTS', 'include'),
            path.join(this.toolchainPath, 'ccs', 'tools', 'compiler', 'ti-cgt-armllvm_4.0.3.LTS', 'include'),
            path.join(this.toolchainPath, 'armcl', 'include')
        ];

        return possibleIncludePaths.filter(p => fs.existsSync(p));
    }
}