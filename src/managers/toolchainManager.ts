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
    
    // TODO: Replace with actual TI download URLs and update when we add license compliance
    private readonly TOOLCHAIN_URLS = {
        'win32-x64': 'https://software-dl.ti.com/codegen/esd/cgt_public_sw/armnone/3.2.2.LTS/ti_cgt_armllvm_3.2.2.LTS_win32.zip',
        'darwin-x64': 'https://software-dl.ti.com/codegen/esd/cgt_public_sw/armnone/3.2.2.LTS/ti_cgt_armllvm_3.2.2.LTS_osx.tar.gz',
        'darwin-arm64': 'https://software-dl.ti.com/codegen/esd/cgt_public_sw/armnone/3.2.2.LTS/ti_cgt_armllvm_3.2.2.LTS_osx.tar.gz',
        'linux-x64': 'https://software-dl.ti.com/codegen/esd/cgt_public_sw/armnone/3.2.2.LTS/ti_cgt_armllvm_3.2.2.LTS_linux-x64.tar.gz'
    };

    private readonly TOOLCHAIN_FOLDER_NAME = 'ti-cgt-armllvm';
    
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
            if (!fs.existsSync(this.toolchainPath)) {
                return defaultInfo;
            }

            // Look for the compiler executable
            const platform = PlatformUtils.getCurrentPlatform();
            const executableName = platform.startsWith('win32') ? 'tiarmclang.exe' : 'tiarmclang';
            
            // Search in common subdirectories
            const possiblePaths = [
                path.join(this.toolchainPath, 'bin', executableName),
                path.join(this.toolchainPath, 'ti_cgt_armllvm_3.2.2.LTS', 'bin', executableName),
                path.join(this.toolchainPath, executableName)
            ];

            let executablePath: string | undefined;
            for (const possiblePath of possiblePaths) {
                if (fs.existsSync(possiblePath)) {
                    executablePath = possiblePath;
                    break;
                }
            }

            if (!executablePath) {
                return defaultInfo;
            }

            // Try to get version information
            const version = await this.getToolchainVersion(executablePath);

            return {
                version,
                path: this.toolchainPath,
                isInstalled: true,
                executablePath
            };

        } catch (error) {
            this.outputChannel.appendLine(`Error getting toolchain info: ${error}`);
            return defaultInfo;
        }
    }

    async installToolchain(progressCallback?: (progress: ToolchainSetupProgress) => void): Promise<void> {
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
            const downloadPath = path.join(os.tmpdir(), `toolchain-${Date.now()}.${downloadUrl.endsWith('.zip') ? 'zip' : 'tar.gz'}`);
            
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
                message: 'Extracting toolchain...'
            });

            // Extract the toolchain
            await this.extractToolchain(downloadPath, this.toolchainPath);

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

            // Clean up download file
            try {
                fs.unlinkSync(downloadPath);
            } catch (cleanupError) {
                this.outputChannel.appendLine(`Warning: Could not clean up download file: ${cleanupError}`);
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
            
            progressCallback?.({
                stage: 'error',
                progress: 0,
                message: `Installation failed: ${errorMessage}`
            });

            // Clean up on failure
            if (fs.existsSync(this.toolchainPath)) {
                try {
                    fs.rmSync(this.toolchainPath, { recursive: true, force: true });
                } catch (cleanupError) {
                    this.outputChannel.appendLine(`Cleanup failed: ${cleanupError}`);
                }
            }

            throw error;
        }
    }

    private async extractToolchain(archivePath: string, extractPath: string): Promise<void> {
        // For MVP, we'll implement basic extraction
        // TODO: Add proper archive extraction using node libraries
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
            
            extractProcess.on('close', (code: number) => {
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
            
            chmodProcess.on('close', (_code: any) => {
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

        // Common library paths for ARM-CGT-CLANG
        const possibleLibPaths = [
            path.join(this.toolchainPath, 'lib'),
            path.join(this.toolchainPath, 'ti_cgt_armllvm_3.2.2.LTS', 'lib'),
            path.join(this.toolchainPath, 'armcl', 'lib')
        ];

        return possibleLibPaths.filter(p => fs.existsSync(p));
    }

    getIncludePaths(): string[] {
        if (!fs.existsSync(this.toolchainPath)) {
            return [];
        }

        // Common include paths for ARM-CGT-CLANG
        const possibleIncludePaths = [
            path.join(this.toolchainPath, 'include'),
            path.join(this.toolchainPath, 'ti_cgt_armllvm_3.2.2.LTS', 'include'),
            path.join(this.toolchainPath, 'armcl', 'include')
        ];

        return possibleIncludePaths.filter(p => fs.existsSync(p));
    }
}