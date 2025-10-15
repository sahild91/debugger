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
    private readonly TOOLCHAIN_PATH_KEY = 'mspm0.toolchainPath';
    private readonly COMPILER_PATH_KEY = 'mspm0.compilerExecutablePath';
    private readonly TOOLCHAIN_LAST_DETECTED_KEY = 'mspm0.toolchainLastDetected';

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
        this.toolchainPath = path.join(DownloadUtils.getBaseInstallPath(), this.TOOLCHAIN_FOLDER_NAME);
        this.downloadUtils = new DownloadUtils(outputChannel);
    }

    /**
 * Save toolchain paths to globalState
 */
    private async saveToolchainPath(basePath: string, executablePath?: string): Promise<void> {
        try {
            await this.context.globalState.update(this.TOOLCHAIN_PATH_KEY, basePath);
            if (executablePath) {
                await this.context.globalState.update(this.COMPILER_PATH_KEY, executablePath);
            }
            await this.context.globalState.update(this.TOOLCHAIN_LAST_DETECTED_KEY, new Date().toISOString());
            this.outputChannel.appendLine(`Saved toolchain path: ${basePath}`);
        } catch (error) {
            this.outputChannel.appendLine(`Failed to save toolchain path: ${error}`);
        }
    }

    /**
     * Load saved compiler executable path
     */
    private async loadSavedCompilerPath(): Promise<string | undefined> {
        const savedPath = this.context.globalState.get<string>(this.COMPILER_PATH_KEY);
        if (savedPath && fs.existsSync(savedPath) && this.verifyCompilerExecutable(savedPath)) {
            this.outputChannel.appendLine(`Loaded saved compiler path: ${savedPath}`);
            return savedPath;
        }
        return undefined;
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
            this.outputChannel.appendLine('Getting ARM-CGT-CLANG toolchain information...');

            // Find the compiler using our prioritized search
            const compilerPath = this.getCompilerPath();

            if (compilerPath) {
                // Extract the base path from the compiler path
                let basePath: string;

                // Handle different directory structures
                if (compilerPath.includes(this.context.globalStorageUri.fsPath)) {
                    // It's in our extension storage
                    basePath = this.toolchainPath;
                    this.outputChannel.appendLine(`Using extension toolchain at: ${basePath}`);
                } else {
                    // It's a system installation - extract base path
                    const parts = compilerPath.split(path.sep);
                    const binIndex = parts.findIndex(part => part === 'bin');
                    if (binIndex > 0) {
                        basePath = parts.slice(0, binIndex).join(path.sep);
                    } else {
                        basePath = path.dirname(compilerPath);
                    }
                    this.outputChannel.appendLine(`Using system toolchain at: ${basePath}`);
                }

                // Try to get version information
                const version = await this.getToolchainVersion(compilerPath);

                await this.saveToolchainPath(basePath, compilerPath);

                return {
                    version,
                    path: basePath,
                    isInstalled: true,
                    executablePath: compilerPath
                };
            }

            this.outputChannel.appendLine('No ARM-CGT-CLANG toolchain found');

            // Provide specific installation guidance
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine('To install ARM-CGT-CLANG toolchain:');
            this.outputChannel.appendLine('   1. Run "Port11 Debugger: Setup Toolchain" command (recommended)');
            this.outputChannel.appendLine('   2. Or manually install from: https://www.ti.com/tool/ARM-CGT');
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine('Searched locations:');
            this.outputChannel.appendLine(`   Extension storage: ${this.toolchainPath}`);
            this.outputChannel.appendLine('   System TI installations: C:\\ti\\, /opt/ti/, etc.');
            this.outputChannel.appendLine('   System PATH');
            this.outputChannel.appendLine('');

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
                    this.outputChannel.appendLine(`  Found compiler executable: ${possiblePath}`);

                    // Try to get version information
                    const version = await this.getToolchainVersion(possiblePath);

                    return {
                        version,
                        path: toolchainPath,
                        isInstalled: true,
                        executablePath: possiblePath
                    };
                } else {
                    this.outputChannel.appendLine(`  Not found: ${possiblePath}`);
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
            const baseInstallPath = DownloadUtils.getBaseInstallPath();
            if (!fs.existsSync(baseInstallPath)) {
                fs.mkdirSync(baseInstallPath, { recursive: true });
                this.outputChannel.appendLine(`Created base install directory: ${baseInstallPath}`);
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
            const compilerPath = this.getCompilerPath();
            if (!compilerPath) {
                throw new Error('Toolchain installation verification failed');
            }

            await this.saveToolchainPath(this.toolchainPath, compilerPath);

            progressCallback?.({
                stage: 'complete',
                progress: 100,
                message: `Toolchain installation complete. Version: ${toolchainInfo.version}`
            });
            return;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Toolchain installation failed: ${errorMessage}`);

            // Clean up download file on error
            if (downloadPath && fs.existsSync(downloadPath)) {
                this.outputChannel.appendLine(`Removing incomplete installer file: ${downloadPath}`);
                try {
                    fs.unlinkSync(downloadPath);
                    this.outputChannel.appendLine('Downloaded installer file cleaned up successfully');
                } catch (cleanupError) {
                    this.outputChannel.appendLine(`Warning: Could not clean up download file: ${cleanupError}`);
                    // Try to make it more obvious to user
                    this.outputChannel.appendLine(`You may need to manually delete: ${downloadPath}`);
                }
            }

            // Clean up installation directory on failure
            if (fs.existsSync(this.toolchainPath)) {
                this.outputChannel.appendLine(`Cleaning up partial toolchain installation at: ${this.toolchainPath}`);
                try {
                    fs.rmSync(this.toolchainPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
                    this.outputChannel.appendLine('Partial toolchain installation cleaned up successfully');
                } catch (cleanupError) {
                    this.outputChannel.appendLine(`Warning: Could not fully clean up toolchain directory: ${cleanupError}`);
                    this.outputChannel.appendLine(`You may need to manually delete: ${this.toolchainPath}`);
                }
            }

            // Complete the error progress callback
            progressCallback?.({
                stage: 'error',
                progress: 0,
                message: `Installation failed: ${errorMessage}`
            });
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
                    "--mode",
                    "unattended", // Silent installation
                    "--prefix",
                    this.toolchainPath, // Installation directory
                ];
            } else if (platform.startsWith('darwin')) {
                // macOS installer (.app.zip)
                this.outputChannel.appendLine('Extracting and running macOS installer...');
                const tempDir = path.dirname(installerPath);

                // Step 1: Unzip the installer
                try {
                    const { execSync } = require("child_process");
                    execSync(`unzip -q -o "${installerPath}" -d "${tempDir}"`);
                    this.outputChannel.appendLine("Extraction complete.");
                } catch (error) {
                    return reject(
                        new Error(`Failed to extract macOS installer: ${error}`)
                    );
                }

                // Step 2: Find the .app file and run it silently
                this.outputChannel.appendLine(
                    "Running the macOS .app installer..."
                );
                const appName = "ti_cgt_armllvm_4.0.3.LTS_osx_installer.app";
                const appPath = path.join(tempDir, appName);

                if (!fs.existsSync(appPath)) {
                    return reject(
                        new Error(`Could not find extracted installer at: ${appPath}`)
                    );
                }

                // On macOS, we use the 'open' command to run .app bundles.
                // The arguments for the installer are passed via the --args flag.
                installCommand = "open";
                installArgs = [
                    "-a",
                    appPath, // Specify the application to open
                    "-W", // Wait for the application to exit before continuing
                    "--args", // Pass the following arguments to the application itself
                    "--mode",
                    "unattended",
                    "--prefix",
                    this.toolchainPath,
                ];
            } else if (platform.startsWith('linux')) {
                // Linux installer (.bin)
                this.outputChannel.appendLine('Running Linux installer...');

                // Make installer executable
                fs.chmodSync(installerPath, '755');

                installCommand = installerPath;
                installArgs = [
                    '--mode', 'unattended',
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
            this.outputChannel.appendLine('Searching for ARM-CGT-CLANG compiler...');

            // Priority 0: Check saved path in globalState (make it async or use sync version)
            const savedPath = this.context.globalState.get<string>(this.COMPILER_PATH_KEY);
            if (savedPath && fs.existsSync(savedPath) && this.verifyCompilerExecutable(savedPath)) {
                this.outputChannel.appendLine(`Using saved compiler path: ${savedPath}`);
                return savedPath;
            }

            // Existing Priority 1: Check extension storage
            const extensionCompilerPath = this.findCompilerInExtensionStorage();
            if (extensionCompilerPath) {
                this.outputChannel.appendLine(`Found compiler in extension storage: ${extensionCompilerPath}`);
                // ADD: Save for next time (use async wrapper)
                return extensionCompilerPath;
            }

            // Third priority: Check system PATH
            const pathCompilerPath = this.findCompilerInSystemPath();
            if (pathCompilerPath) {
                this.outputChannel.appendLine(`Found compiler in system PATH: ${pathCompilerPath}`);
                return pathCompilerPath;
            }

            this.outputChannel.appendLine('No compiler found in any location');
            return undefined;

        } catch (error) {
            this.outputChannel.appendLine(`Error getting compiler path: ${error}`);
            return undefined;
        }
    }

    private findCompilerInExtensionStorage(): string | undefined {
        const platform = PlatformUtils.getCurrentPlatform();
        const executableName = platform.startsWith('win32') ? 'tiarmclang.exe' : 'tiarmclang';

        this.outputChannel.appendLine(`Checking extension storage: ${this.toolchainPath}`);

        if (!fs.existsSync(this.toolchainPath)) {
            this.outputChannel.appendLine(`   Extension toolchain directory doesn't exist: ${this.toolchainPath}`);
            return undefined;
        }

        // Possible subdirectory structures in our extension installation
        const possiblePaths = [
            // Direct in bin directory
            path.join(this.toolchainPath, 'bin', executableName),

            // With version folder structure (what TI installers typically create)
            path.join(this.toolchainPath, 'ti-cgt-armllvm_4.0.3.LTS', 'bin', executableName),
            path.join(this.toolchainPath, 'ti-cgt-armllvm_3.2.2.LTS', 'bin', executableName),
            path.join(this.toolchainPath, 'ti-cgt-armllvm_3.2.1.LTS', 'bin', executableName),
            path.join(this.toolchainPath, 'ti-cgt-armllvm_4.0.2.LTS', 'bin', executableName),

            // Alternative structures
            path.join(this.toolchainPath, 'tools', 'bin', executableName),
            path.join(this.toolchainPath, 'compiler', 'bin', executableName),

            // Direct in root (some installers do this)
            path.join(this.toolchainPath, executableName),

            // Windows-specific paths that some TI installers create
            path.join(this.toolchainPath, 'ccs', 'tools', 'compiler', 'ti-cgt-armllvm_4.0.3.LTS', 'bin', executableName),
        ];

        for (const compilerPath of possiblePaths) {
            this.outputChannel.appendLine(`   Checking: ${compilerPath}`);

            if (fs.existsSync(compilerPath)) {
                // Verify it's actually executable
                if (this.verifyCompilerExecutable(compilerPath)) {
                    this.outputChannel.appendLine(`   Valid compiler found: ${compilerPath}`);
                    return compilerPath;
                } else {
                    this.outputChannel.appendLine(`   File exists but not valid: ${compilerPath}`);
                }
            } else {
                this.outputChannel.appendLine(`   Not found: ${compilerPath}`);
            }
        }

        return undefined;
    }

    private verifyCompilerExecutable(execPath: string): boolean {
        try {
            const stats = fs.statSync(execPath);

            if (!stats.isFile()) {
                this.outputChannel.appendLine(`      Not a file: ${execPath}`);
                return false;
            }

            // On Unix systems, check if executable bit is set
            if (process.platform !== 'win32') {
                const hasExecutePermission = (stats.mode & parseInt('111', 8)) !== 0;
                if (!hasExecutePermission) {
                    this.outputChannel.appendLine(`      File not executable: ${execPath}`);
                    return false;
                }
            }

            this.outputChannel.appendLine(`      Valid executable: ${execPath}`);
            return true;
        } catch (error) {
            this.outputChannel.appendLine(`      Error verifying: ${error}`);
            return false;
        }
    }

    // 3. System locations search (fallback for user-installed toolchains)
    private findCompilerInSystemLocations(): string | undefined {
        const platform = PlatformUtils.getCurrentPlatform();
        const executableName = platform.startsWith('win32') ? 'tiarmclang.exe' : 'tiarmclang';

        this.outputChannel.appendLine('Checking system TI installation locations...');

        // Define system-wide TI installation paths
        const systemPaths: string[] = [];

        if (platform.startsWith('win32')) {
            systemPaths.push(
                // YuduRobotics plugin location (priority)
                'C:\\YuduRobotics\\plugins\\ti-cgt-armllvm-4.0.3',

                // TI CCS standard locations
                'C:\\ti\\ccs\\tools\\compiler\\ti-cgt-armllvm_4.0.3.LTS',
                'C:\\ti\\ccs\\tools\\compiler\\ti-cgt-armllvm_3.2.2.LTS',
                'C:\\ti\\ccs\\tools\\compiler\\ti-cgt-armllvm_3.2.1.LTS',

                // Standalone installations
                'C:\\ti\\ti-cgt-armllvm_4.0.3.LTS',
                'C:\\ti\\ti-cgt-armllvm_3.2.2.LTS',
                'C:\\ti\\ti-cgt-armllvm_3.2.1.LTS',

                // Program Files locations
                'C:\\Program Files\\Texas Instruments\\ti-cgt-armllvm_4.0.3.LTS',
                'C:\\Program Files\\Texas Instruments\\ti-cgt-armllvm_3.2.2.LTS',
                'C:\\Program Files (x86)\\Texas Instruments\\ti-cgt-armllvm_4.0.3.LTS',
                'C:\\Program Files (x86)\\Texas Instruments\\ti-cgt-armllvm_3.2.2.LTS'
            );
        } else if (platform.startsWith('darwin')) {
            systemPaths.push(
                // YuduRobotics plugin location (priority)
                path.join(os.homedir(), 'YuduRobotics', 'plugins', 'ti-cgt-armllvm-4.0.3'),
                '/Applications/ti/ccs/tools/compiler/ti-cgt-armllvm_4.0.3.LTS',
                '/Applications/ti/ccs/tools/compiler/ti-cgt-armllvm_3.2.2.LTS',
                '/Applications/ti/ti-cgt-armllvm_4.0.3.LTS',
                '/Applications/ti/ti-cgt-armllvm_3.2.2.LTS',
                '/opt/ti/ti-cgt-armllvm_4.0.3.LTS',
                '/opt/ti/ti-cgt-armllvm_3.2.2.LTS'
            );
        } else {
            // Linux paths (including your example from compiler commands)
            systemPaths.push(
                // YuduRobotics plugin location (priority)
                path.join(os.homedir(), 'YuduRobotics', 'plugins', 'ti-cgt-armllvm-4.0.3'),
                '/home/ti-cgt-armllvm_3.2.2.LTS',  // From your example
                '/home/ti-cgt-armllvm_4.0.3.LTS',
                '/opt/ti/ti-cgt-armllvm_4.0.3.LTS',
                '/opt/ti/ti-cgt-armllvm_3.2.2.LTS',
                '/opt/ti/ti-cgt-armllvm_3.2.1.LTS',
                '/usr/local/ti/ti-cgt-armllvm_4.0.3.LTS',
                '/usr/local/ti/ti-cgt-armllvm_3.2.2.LTS'
            );
        }

        for (const basePath of systemPaths) {
            this.outputChannel.appendLine(`   Checking system path: ${basePath}`);

            if (!fs.existsSync(basePath)) {
                this.outputChannel.appendLine(`   Path doesn't exist`);
                continue;
            }

            const compilerPath = path.join(basePath, 'bin', executableName);
            this.outputChannel.appendLine(`   Checking compiler: ${compilerPath}`);

            if (fs.existsSync(compilerPath) && this.verifyCompilerExecutable(compilerPath)) {
                this.outputChannel.appendLine(`   Valid system compiler found: ${compilerPath}`);
                return compilerPath;
            }
        }

        this.outputChannel.appendLine('   No valid compiler in system locations');
        return undefined;
    }

    // 4. System PATH search (final fallback)
    private findCompilerInSystemPath(): string | undefined {
        const platform = PlatformUtils.getCurrentPlatform();
        const executableName = platform.startsWith('win32') ? 'tiarmclang.exe' : 'tiarmclang';

        this.outputChannel.appendLine('Checking system PATH...');

        try {
            const { execSync } = require('child_process');
            let command: string;

            if (platform.startsWith('win32')) {
                command = `where ${executableName}`;
            } else {
                command = `which ${executableName}`;
            }

            const result = execSync(command, { encoding: 'utf8', timeout: 5000 }).toString().trim();

            if (result && fs.existsSync(result)) {
                this.outputChannel.appendLine(`   Found in PATH: ${result}`);
                return result;
            }
        } catch (error) {
            this.outputChannel.appendLine(`   Not found in PATH: ${error}`);
        }

        return undefined;
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