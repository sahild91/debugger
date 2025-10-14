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
    private readonly SYSCONFIG_PATH_KEY = 'mspm0.sysconfigPath';
    private readonly SYSCONFIG_CLI_PATH_KEY = 'mspm0.sysconfigCliPath';
    private readonly SYSCONFIG_LAST_DETECTED_KEY = 'mspm0.sysconfigLastDetected';

    // TI SysConfig direct download URLs (v1.24.2.4234)
    private readonly SYSCONFIG_URLS = {
        'win32-x64': 'https://dr-download.ti.com/software-development/ide-configuration-compiler-or-debugger/MD-nsUM6f7Vvb/1.24.2.4234/sysconfig-1.24.2_4234-setup.exe',
        'darwin-x64': 'https://dr-download.ti.com/software-development/ide-configuration-compiler-or-debugger/MD-nsUM6f7Vvb/1.24.2.4234/sysconfig-1.24.2_4234-setup.dmg',
        'darwin-arm64': 'https://dr-download.ti.com/software-development/ide-configuration-compiler-or-debugger/MD-nsUM6f7Vvb/1.24.2.4234/sysconfig-1.24.2_4234-setup.dmg',
        'linux-x64': 'https://dr-download.ti.com/software-development/ide-configuration-compiler-or-debugger/MD-nsUM6f7Vvb/1.24.2.4234/sysconfig-1.24.2_4234-setup.run',
        'linux-arm64': 'https://dr-download.ti.com/software-development/ide-configuration-compiler-or-debugger/MD-nsUM6f7Vvb/1.24.2.4234/sysconfig-1.24.2_4234-setup.run'
    };

    private readonly SYSCONFIG_VERSION = '1.24.2.4234';
    private readonly SYSCONFIG_FOLDER_NAME = 'sysconfig-1.24.2';

    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.sysConfigPath = path.join(DownloadUtils.getBaseInstallPath(), this.SYSCONFIG_FOLDER_NAME);
        this.downloadUtils = new DownloadUtils(outputChannel);
    }

    /**
 * Save SysConfig paths to globalState
 */
    private async saveSysConfigPath(basePath: string, cliPath?: string): Promise<void> {
        try {
            await this.context.globalState.update(this.SYSCONFIG_PATH_KEY, basePath);
            if (cliPath) {
                await this.context.globalState.update(this.SYSCONFIG_CLI_PATH_KEY, cliPath);
            }
            await this.context.globalState.update(this.SYSCONFIG_LAST_DETECTED_KEY, new Date().toISOString());
            this.outputChannel.appendLine(`Saved SysConfig path: ${basePath}`);
        } catch (error) {
            this.outputChannel.appendLine(`Failed to save SysConfig path: ${error}`);
        }
    }

    /**
     * Load saved SysConfig CLI path
     */
    private async loadSavedSysConfigCliPath(): Promise<string | undefined> {
        const savedPath = this.context.globalState.get<string>(this.SYSCONFIG_CLI_PATH_KEY);
        if (savedPath && fs.existsSync(savedPath)) {
            this.outputChannel.appendLine(`Loaded saved SysConfig CLI path: ${savedPath}`);
            return savedPath;
        }
        return undefined;
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
                // YuduRobotics plugin locations
                'C:\\YuduRobotics\\plugins\\sysconfig-1.24.2',
                path.join(os.homedir(), 'YuduRobotics', 'plugins', 'sysconfig-1.24.2'),
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

            // Priority 0: Check saved path
            const savedCliPath = await this.loadSavedSysConfigCliPath();
            if (savedCliPath) {
                const savedBasePath = this.context.globalState.get<string>(this.SYSCONFIG_PATH_KEY);
                if (savedBasePath && fs.existsSync(savedBasePath)) {
                    const version = await this.getSysConfigVersion(savedCliPath);
                    return {
                        version,
                        path: savedBasePath,
                        isInstalled: true,
                        cliPath: savedCliPath
                    };
                }
            }

            for (const searchPath of searchPaths) {
                this.outputChannel.appendLine(`Checking: ${searchPath}`);

                if (fs.existsSync(searchPath)) {
                    this.outputChannel.appendLine(`Found directory: ${searchPath}`);

                    const sysConfigInfo = await this.validateSysConfigAtPath(searchPath);
                    if (sysConfigInfo.isInstalled) {
                        this.outputChannel.appendLine(`Valid SysConfig found at: ${searchPath}`);
                        // Update our internal path to the actual location
                        this.sysConfigPath = searchPath;
                        return sysConfigInfo;
                    } else {
                        this.outputChannel.appendLine(`Directory exists but no valid SysConfig found`);
                    }
                } else {
                    this.outputChannel.appendLine(`Directory does not exist`);
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

            this.outputChannel.appendLine('SysConfig not found in any expected location');
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
                    this.outputChannel.appendLine(`  Found SysConfig CLI: ${possiblePath}`);

                    // Try to get version information
                    const version = await this.getSysConfigVersion(possiblePath);

                    return {
                        version,
                        path: sysConfigPath,
                        isInstalled: true,
                        cliPath: possiblePath
                    };
                } else {
                    this.outputChannel.appendLine(`  Not found: ${possiblePath}`);
                }
            }

            return defaultInfo;

        } catch (error) {
            this.outputChannel.appendLine(`Error validating SysConfig: ${error}`);
            return defaultInfo;
        }
    }

    private getSysConfigCliPaths(sysConfigPath: string, platform: string): string[] {
        const paths: string[] = [];

        if (platform.startsWith('win32')) {
            // Windows paths
            paths.push(
                path.join(sysConfigPath, 'sysconfig_cli.bat'),
                path.join(sysConfigPath, 'bin', 'sysconfig_cli.bat'),
                path.join(sysConfigPath, 'eclipse', 'sysconfig_cli.bat'),
                path.join(sysConfigPath, 'SysConfig.exe'),
                path.join(sysConfigPath, 'bin', 'SysConfig.exe')
            );
        } else if (platform.startsWith('darwin')) {
            // macOS paths
            paths.push(
                path.join(sysConfigPath, 'sysconfig_cli.sh'),
                path.join(sysConfigPath, 'bin', 'sysconfig_cli.sh'),
                path.join(sysConfigPath, 'eclipse', 'sysconfig_cli.sh'),
                path.join(sysConfigPath, 'SysConfig.app', 'Contents', 'MacOS', 'sysconfig_cli.sh')
            );
        } else {
            // Linux paths
            paths.push(
                path.join(sysConfigPath, 'sysconfig_cli.sh'),
                path.join(sysConfigPath, 'bin', 'sysconfig_cli.sh'),
                path.join(sysConfigPath, 'eclipse', 'sysconfig_cli.sh')
            );
        }

        return paths;
    }

    private async getSysConfigVersion(cliPath: string): Promise<string> {
        try {
            const { spawn } = require('child_process');
            const platform = PlatformUtils.getCurrentPlatform();

            return new Promise<string>((resolve) => {
                let versionProcess: any;

                if (platform.startsWith('win32') && cliPath.endsWith('.bat')) {
                    // On Windows, batch files need to be run through cmd
                    versionProcess = spawn('cmd', ['/c', `"${cliPath}"`, '--version'], {
                        stdio: ['pipe', 'pipe', 'pipe'],
                        windowsHide: true
                    });
                } else {
                    // Direct execution for Unix systems or .exe files
                    versionProcess = spawn(cliPath, ['--version'], {
                        stdio: ['pipe', 'pipe', 'pipe']
                    });
                }

                let output = '';

                versionProcess.stdout?.on('data', (data: Buffer) => {
                    output += data.toString();
                });

                versionProcess.stderr?.on('data', (data: Buffer) => {
                    output += data.toString();
                });

                versionProcess.on('close', () => {
                    // Try to extract version from output
                    const versionMatch = output.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
                    if (versionMatch) {
                        this.outputChannel.appendLine(`SysConfig version detected: ${versionMatch[1]}`);
                        resolve(versionMatch[1]);
                    } else {
                        this.outputChannel.appendLine(`Could not parse version from output: ${output.substring(0, 200)}`);
                        // Fallback to expected version
                        resolve(this.SYSCONFIG_VERSION);
                    }
                });

                versionProcess.on('error', (error: any) => {
                    this.outputChannel.appendLine(`Error getting SysConfig version: ${error.message}`);
                    resolve('Unknown');
                });

                // Set timeout
                setTimeout(() => {
                    if (versionProcess && !versionProcess.killed) {
                        versionProcess.kill();
                        this.outputChannel.appendLine('SysConfig version check timed out');
                        resolve('Unknown');
                    }
                }, 10000);
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
            const baseInstallPath = DownloadUtils.getBaseInstallPath();
            if (!fs.existsSync(baseInstallPath)) {
                fs.mkdirSync(baseInstallPath, { recursive: true });
                this.outputChannel.appendLine(`Created base install directory: ${baseInstallPath}`);
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

            // Validate the installation with more lenient criteria
            let installationValid = false;
            let validationError = '';
            let sysConfigInfo: SysConfigInfo | null = null;

            try {
                sysConfigInfo = await this.getSysConfigInfo();
                installationValid = sysConfigInfo.isInstalled;
                if (!installationValid) {
                    validationError = 'CLI executable not found in expected locations';
                }
            } catch (validationErr) {
                validationError = validationErr instanceof Error ? validationErr.message : String(validationErr);
                // Check if files were actually installed even if validation failed
                const hasFiles = fs.existsSync(this.sysConfigPath) && fs.readdirSync(this.sysConfigPath).length > 0;
                if (hasFiles) {
                    this.outputChannel.appendLine(`Installation files present despite validation error: ${validationError}`);
                    this.outputChannel.appendLine('Continuing - installation may still be functional');
                    installationValid = true;
                    // Create a fallback sysConfigInfo for logging
                    sysConfigInfo = {
                        version: this.SYSCONFIG_VERSION,
                        path: this.sysConfigPath,
                        isInstalled: true
                    };
                }
            }

            if (!installationValid) {
                throw new Error(`SysConfig validation failed: ${validationError}`);
            }

            // Clean up download file on success
            if (downloadPath && fs.existsSync(downloadPath)) {
                try {
                    fs.unlinkSync(downloadPath);
                } catch (cleanupError) {
                    this.outputChannel.appendLine(`Warning: Could not clean up download file: ${cleanupError}`);
                }
            }

            this.outputChannel.appendLine(`TI SysConfig installed successfully. Version: ${sysConfigInfo?.version || 'Unknown'}`);

            const cliPath = this.getSysConfigCliPath();

            await this.saveSysConfigPath(this.sysConfigPath, cliPath);

            progressCallback?.({
                stage: 'complete',
                progress: 100,
                message: `SysConfig installation complete. Version: ${sysConfigInfo?.version || 'Unknown'}`
            });
            return;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`SysConfig installation failed: ${errorMessage}`);

            // Clean up download file on error
            if (downloadPath && fs.existsSync(downloadPath)) {
                try {
                    fs.unlinkSync(downloadPath);
                    this.outputChannel.appendLine('Cleaned up downloaded installer file');
                } catch (cleanupError) {
                    this.outputChannel.appendLine(`Warning: Could not clean up download file: ${cleanupError}`);
                }
            }

            // Clean up installation directory on failure - BUT ONLY if validation actually failed
            // Don't delete if the installation succeeded but validation had issues
            const isActualInstallationFailure = !fs.existsSync(this.sysConfigPath) ||
                !fs.readdirSync(this.sysConfigPath).length;

            if (isActualInstallationFailure && fs.existsSync(this.sysConfigPath)) {
                try {
                    fs.rmSync(this.sysConfigPath, { recursive: true, force: true });
                    this.outputChannel.appendLine('Cleaned up empty installation directory');
                } catch (cleanupError) {
                    this.outputChannel.appendLine(`SysConfig cleanup failed: ${cleanupError}`);
                }
            } else if (fs.existsSync(this.sysConfigPath)) {
                this.outputChannel.appendLine('Preserving installation directory - files were installed successfully');
            }

            throw error;
        }
    }

    private getInstallerFileName(url: string): string {
        const urlParts = url.split('/');
        return urlParts[urlParts.length - 1];
    }

    private async installSysConfigFromFile(installerPath: string, platform: string): Promise<void> {
        const { spawnSync, spawn } = require("child_process");

        return new Promise((resolve, reject) => {
            // Ensure install directory exists
            if (!fs.existsSync(this.sysConfigPath)) {
                fs.mkdirSync(this.sysConfigPath, { recursive: true });
            }

            if (platform.startsWith("darwin")) {
                let mountPoint: string | null = null;
                try {
                    this.outputChannel.appendLine(
                        `Step 1: Mounting DMG: ${installerPath}`
                    );
                    const attachProcess = spawnSync("hdiutil", [
                        "attach",
                        installerPath,
                        "-nobrowse",
                    ]);

                    if (attachProcess.status !== 0) {
                        const stderr = attachProcess.stderr.toString();
                        throw new Error(
                            `Failed to mount DMG. Exit code: ${attachProcess.status}. Stderr: ${stderr}`
                        );
                    }

                    const attachOutput = attachProcess.stdout.toString();
                    this.outputChannel.appendLine(`Mount output: ${attachOutput}`);

                    const mountMatch = attachOutput.match(/\/Volumes\/[^\n\r]+/);
                    if (!mountMatch) {
                        throw new Error(
                            "Could not determine mount point from hdiutil output."
                        );
                    }
                    mountPoint = mountMatch[0].trim();
                    this.outputChannel.appendLine(`DMG mounted at: ${mountPoint}`);

                    if (mountPoint) {
                        // Find the installer .app on the mounted volume
                        const appName = fs
                            .readdirSync(mountPoint)
                            .find((file) => file.endsWith(".app"));
                        if (!appName) {
                            throw new Error(
                                "Could not find installer .app file on the mounted volume."
                            );
                        }
                        const installerAppPath = path.join(mountPoint, appName);

                        this.outputChannel.appendLine(
                            `Step 2: Running installer from ${installerAppPath}`
                        );

                        // We don't use the generic `executeInstaller` here because this is a specific sequence.
                        const installProcess = spawnSync("open", [
                            "-a",
                            installerAppPath,
                            "-W", // Wait for the app to exit
                            "--args",
                            "--mode",
                            "unattended",
                            "--prefix",
                            this.sysConfigPath,
                        ]);

                        if (installProcess.status !== 0) {
                            const stderr = installProcess.stderr.toString();
                            throw new Error(
                                `SysConfig installer failed. Exit code: ${installProcess.status}. Stderr: ${stderr}`
                            );
                        }

                        this.outputChannel.appendLine("Installer finished successfully.");
                        resolve();
                    } else {
                        throw new Error("Mount point was unexpectedly null.");
                    }
                } catch (error) {
                    reject(error);
                } finally {
                    if (mountPoint) {
                        this.outputChannel.appendLine(
                            `Step 3: Unmounting DMG at ${mountPoint}`
                        );
                        // Use sync here to ensure it happens before the function truly exits
                        spawnSync("hdiutil", ["detach", mountPoint], { stdio: "ignore" });
                    }
                }
                return;
            }

            // --- Logic for Windows and Linux ---
            let installCommand: string;
            let installArgs: string[];

            if (platform.startsWith("win32")) {
                installCommand = installerPath;
                installArgs = ["--mode", "unattended", "--prefix", this.sysConfigPath];
            } else { // Linux
                this.outputChannel.appendLine('Making SysConfig installer executable...');
                fs.chmodSync(installerPath, '755'); // Make the .run file executable

                installCommand = installerPath; // The command IS the installer file itself
                installArgs = [
                    "--mode",
                    "unattended",
                    "--prefix",
                    this.sysConfigPath,
                ];
            }

            this.outputChannel.appendLine(
                `Install command: ${installCommand} ${installArgs.join(" ")}`
            );
            this.executeInstaller(
                installCommand,
                installArgs,
                resolve,
                reject,
                platform
            );
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

        // Try different execution methods for Windows, including different argument formats
        const executionMethods = platform.startsWith('win32')
            ? [
                {
                    name: 'Standard unattended install',
                    useShell: false,
                    args: ['--mode', 'unattended', '--prefix', this.sysConfigPath]
                },
                {
                    name: 'NSIS silent install',
                    useShell: false,
                    args: ['/S', `/D=${this.sysConfigPath}`]
                },
                {
                    name: 'Shell execution with standard args',
                    useShell: true,
                    args: ['--mode', 'unattended', '--prefix', this.sysConfigPath]
                },
                {
                    name: 'PowerShell execution',
                    usePowerShell: true,
                    args: ['--mode', 'unattended', '--prefix', this.sysConfigPath]
                }
            ]
            : [{
                name: 'Direct execution',
                useShell: false,
                args: args
            }];

        let currentMethod = 0;

        const tryNextMethod = () => {
            if (currentMethod >= executionMethods.length) {
                reject(new Error('All execution methods failed'));
                return;
            }

            const method = executionMethods[currentMethod];
            this.outputChannel.appendLine(`Attempting: ${method.name}`);
            this.outputChannel.appendLine(`Arguments: ${method.args.join(' ')}`);
            currentMethod++;

            let installProcess: any;

            try {
                if (method.usePowerShell) {
                    // Use PowerShell as a fallback for Windows
                    const psCommand = `Start-Process "${command}" -ArgumentList "${method.args.join('","')}" -Wait -PassThru`;
                    installProcess = spawn('powershell', ['-Command', psCommand], {
                        stdio: ['pipe', 'pipe', 'pipe']
                    });
                } else {
                    installProcess = spawn(command, method.args, {
                        stdio: ['pipe', 'pipe', 'pipe'],
                        shell: method.useShell
                    });
                }

                let stdout = '';
                let stderr = '';

                installProcess.stdout?.on('data', (data: any) => {
                    const output = data.toString();
                    stdout += output;
                    this.outputChannel.append(output);
                });

                installProcess.stderr?.on('data', (data: any) => {
                    const output = data.toString();
                    stderr += output;
                    this.outputChannel.append(output);
                });

                installProcess.on('close', (code: number) => {
                    if (code === 0) {
                        this.outputChannel.appendLine(`${method.name} completed successfully`);
                        resolve();
                    } else {
                        this.outputChannel.appendLine(`${method.name} failed with exit code ${code}`);
                        this.outputChannel.appendLine(`stderr: ${stderr}`);
                        tryNextMethod();
                    }
                });

                installProcess.on('error', (error: any) => {
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

    private async setupExecutablePermissions(): Promise<void> {
        try {
            const platform = PlatformUtils.getCurrentPlatform();
            const cliPaths = this.getSysConfigCliPaths(this.sysConfigPath, platform);

            for (const cliPath of cliPaths) {
                if (fs.existsSync(cliPath)) {
                    // Set executable permissions
                    fs.chmodSync(cliPath, 0o755);
                    this.outputChannel.appendLine(`Set executable permissions for: ${cliPath}`);
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(`Warning: Could not set executable permissions: ${error}`);
        }
    }

    async uninstallSysConfig(): Promise<void> {
        try {
            if (fs.existsSync(this.sysConfigPath)) {
                fs.rmSync(this.sysConfigPath, { recursive: true, force: true });
                this.outputChannel.appendLine(`SysConfig uninstalled from: ${this.sysConfigPath}`);
            } else {
                this.outputChannel.appendLine('SysConfig not found for uninstallation');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`SysConfig uninstallation failed: ${errorMessage}`);
            throw error;
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

    async getSysConfigCliPathAsync(): Promise<string | null> {
        try {
            const sysConfigInfo = await this.getSysConfigInfo();
            return sysConfigInfo.cliPath || null;
        } catch (error) {
            this.outputChannel.appendLine(`Error getting SysConfig CLI path: ${error}`);
            return null;
        }
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
            const platform = PlatformUtils.getCurrentPlatform();

            return new Promise((resolve) => {
                let testProcess: any;

                if (platform.startsWith('win32') && cliPath.endsWith('.bat')) {
                    // On Windows, batch files need to be run through cmd
                    testProcess = spawn('cmd', ['/c', `"${cliPath}"`, '--help'], {
                        stdio: ['pipe', 'pipe', 'pipe'],
                        windowsHide: true
                    });
                } else {
                    // Direct execution for Unix systems or .exe files
                    testProcess = spawn(cliPath, ['--help'], {
                        stdio: ['pipe', 'pipe', 'pipe']
                    });
                }

                let hasOutput = false;

                testProcess.stdout?.on('data', (data: any) => {
                    hasOutput = true;
                    this.outputChannel.appendLine(`SysConfig validation output: ${data.toString().substring(0, 200)}`);
                });

                testProcess.stderr?.on('data', (data: any) => {
                    const output = data.toString();
                    this.outputChannel.appendLine(`SysConfig validation stderr: ${output.substring(0, 200)}`);
                    // Some tools output help to stderr, so this is not necessarily an error
                    hasOutput = true;
                });

                testProcess.on('close', (code: number) => {
                    this.outputChannel.appendLine(`SysConfig validation completed with exit code: ${code}`);
                    // Consider it valid if we got some output, even if exit code is non-zero
                    // (some tools return non-zero for --help)
                    resolve(hasOutput || code === 0);
                });

                testProcess.on('error', (error: any) => {
                    this.outputChannel.appendLine(`SysConfig validation error: ${error.message}`);
                    resolve(false);
                });

                setTimeout(() => {
                    if (testProcess && !testProcess.killed) {
                        testProcess.kill();
                        this.outputChannel.appendLine('SysConfig validation timed out');
                        resolve(hasOutput); // If we got output before timeout, consider it valid
                    }
                }, 10000); // 10 second timeout
            });
        } catch (error) {
            this.outputChannel.appendLine(`Error validating SysConfig for build: ${error}`);
            return false;
        }
    }
}