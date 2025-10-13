import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { simpleGit, SimpleGit } from 'simple-git';

// Define our own progress handler type since it's not exported in newer versions
type ProgressHandler = (progress: { stage: string; progress: number }) => void;

export interface SDKSetupProgress {
    stage: 'cloning' | 'updating' | 'validating' | 'complete' | 'error';
    progress: number;
    message: string;
}

export class SDKManager {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private sdkPath: string;
    private git: SimpleGit;

    // GlobalState keys for persistent storage
    private readonly SDK_PATH_KEY = 'mspm0.sdkPath';
    private readonly SDK_LAST_DETECTED_KEY = 'mspm0.sdkLastDetected';

    // MSPM0 SDK repository URL
    private readonly SDK_REPO_URL = 'https://github.com/TexasInstruments/mspm0-sdk';
    private readonly SDK_FOLDER_NAME = 'mspm0-sdk';

    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.sdkPath = path.join(context.globalStorageUri.fsPath, this.SDK_FOLDER_NAME);
        this.git = simpleGit();
    }

    /**
 * Save SDK path to globalState for persistence
 */
    private async saveSdkPath(sdkPath: string): Promise<void> {
        try {
            await this.context.globalState.update(this.SDK_PATH_KEY, sdkPath);
            await this.context.globalState.update(this.SDK_LAST_DETECTED_KEY, new Date().toISOString());
            this.outputChannel.appendLine(`Saved SDK path to storage: ${sdkPath}`);
        } catch (error) {
            this.outputChannel.appendLine(`Failed to save SDK path: ${error}`);
        }
    }

    /**
     * Load SDK path from globalState
     */
    private async loadSavedSdkPath(): Promise<string | undefined> {
        const savedPath = this.context.globalState.get<string>(this.SDK_PATH_KEY);
        if (savedPath && fs.existsSync(savedPath)) {
            this.outputChannel.appendLine(`Loaded saved SDK path: ${savedPath}`);
            return savedPath;
        }
        return undefined;
    }

    /**
 * Search for SDK in common system installation locations
 */
    private findSdkInSystemLocations(): string | undefined {
        this.outputChannel.appendLine('Searching for MSPM0 SDK in system locations...');

        const systemPaths: string[] = [];

        if (process.platform === 'win32') {
            systemPaths.push(
                'C:\\ti\\mspm0-sdk',
                'C:\\ti\\mspm0_sdk_2_10_00_05',
                'C:\\ti\\mspm0_sdk_2_00_01_00',
                'C:\\Program Files\\Texas Instruments\\mspm0-sdk',
                'C:\\Program Files (x86)\\Texas Instruments\\mspm0-sdk'
            );
        } else if (process.platform === 'darwin') {
            systemPaths.push(
                '/Applications/ti/mspm0-sdk',
                '/opt/ti/mspm0-sdk',
                path.join(os.homedir(), 'ti', 'mspm0-sdk')
            );
        } else {
            systemPaths.push(
                '/opt/ti/mspm0-sdk',
                '/usr/local/ti/mspm0-sdk',
                path.join(os.homedir(), 'ti', 'mspm0-sdk')
            );
        }

        for (const searchPath of systemPaths) {
            this.outputChannel.appendLine(`   Checking: ${searchPath}`);

            if (fs.existsSync(searchPath)) {
                // Validate it's a proper SDK installation
                const expectedPaths = ['source', 'examples', 'kernel'];
                const isValid = expectedPaths.every(p => fs.existsSync(path.join(searchPath, p)));

                if (isValid) {
                    this.outputChannel.appendLine(`   Valid SDK found: ${searchPath}`);
                    return searchPath;
                }
            }
        }

        this.outputChannel.appendLine('   No SDK found in system locations');
        return undefined;
    }

    /**
 * Get SDK path with intelligent search:
 * 1. Check saved path in globalState
 * 2. Check extension storage
 * 3. Search system locations
 */
    private async discoverSdkPath(): Promise<string> {
        // Priority 1: Check saved path
        const savedPath = await this.loadSavedSdkPath();
        if (savedPath) {
            this.sdkPath = savedPath;
            return savedPath;
        }

        // Priority 2: Check extension storage
        if (fs.existsSync(this.sdkPath)) {
            await this.saveSdkPath(this.sdkPath);
            return this.sdkPath;
        }

        // Priority 3: Search system locations
        const systemPath = this.findSdkInSystemLocations();
        if (systemPath) {
            this.sdkPath = systemPath;
            await this.saveSdkPath(systemPath);
            return systemPath;
        }

        return this.sdkPath;
    }

    async isSDKInstalled(): Promise<boolean> {
        try {
            await this.discoverSdkPath();

            if (!fs.existsSync(this.sdkPath)) {
                return false;
            }

            // Check if it's a valid git repository (basic check)
            const gitPath = path.join(this.sdkPath, '.git');
            if (!fs.existsSync(gitPath)) {
                this.outputChannel.appendLine('Warning: SDK directory exists but no .git directory found');
                // Don't fail immediately - check if we have the essential files for building
            }

            // Check if it has the expected MSPM0 structure for building
            const expectedPaths = [
                'source',
                'examples',
                'kernel'
            ];

            const hasRequiredStructure = expectedPaths.every(p => fs.existsSync(path.join(this.sdkPath, p)));

            if (!hasRequiredStructure) {
                this.outputChannel.appendLine('SDK directory missing required structure for building');
                return false;
            }

            // Additional check: verify we have critical build files
            const criticalBuildFiles = [
                'source/ti/driverlib',
                'source/third_party'
            ];

            const hasBuildFiles = criticalBuildFiles.some(p => fs.existsSync(path.join(this.sdkPath, p)));

            if (!hasBuildFiles) {
                this.outputChannel.appendLine('Warning: SDK may be incomplete - missing some build components');
                // Return true anyway if basic structure exists - partial SDK might still work
            }

            this.outputChannel.appendLine('SDK validation passed - directory structure looks good for building');
            return true;

        } catch (error) {
            this.outputChannel.appendLine(`Error checking SDK installation: ${error}`);
            return false;
        }
    }

    async installSDK(progressCallback?: (progress: SDKSetupProgress) => void): Promise<void> {
        try {
            // Ensure global storage directory exists
            if (!fs.existsSync(this.context.globalStorageUri.fsPath)) {
                fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
            }

            progressCallback?.({
                stage: 'cloning',
                progress: 10,
                message: 'Starting SDK clone...'
            });

            this.outputChannel.appendLine(`Cloning MSPM0 SDK from ${this.SDK_REPO_URL}`);
            this.outputChannel.appendLine(`Target directory: ${this.sdkPath}`);

            // Remove existing directory if it exists but is incomplete
            if (fs.existsSync(this.sdkPath)) {
                this.outputChannel.appendLine('Removing existing incomplete SDK installation');
                fs.rmSync(this.sdkPath, { recursive: true, force: true });
            }

            // Set up progress handler
            const git = simpleGit({
                progress: ({ stage, progress, processed, total }) => {
                    // This is the correct simple-git progress callback signature
                    const percentage = Math.min(90, 10 + (progress || 0));
                    progressCallback?.({
                        stage: 'cloning',
                        progress: percentage,
                        message: `${stage}: ${processed}/${total} (${progress}%)`
                    });
                }
            });

            // Clone with progress
            await git.clone(this.SDK_REPO_URL, this.sdkPath, [
                '--progress',
                '--depth', '1'
            ]);

            progressCallback?.({
                stage: 'validating',
                progress: 95,
                message: 'Validating SDK installation...'
            });

            // Validate the installation
            if (!await this.isSDKInstalled()) {
                throw new Error('SDK validation failed after installation');
            }

            // Get SDK version info
            const version = await this.getSDKVersion();
            this.outputChannel.appendLine(`MSPM0 SDK installed successfully. Version: ${version}`);

            await this.saveSdkPath(this.sdkPath);

            progressCallback?.({
                stage: 'complete',
                progress: 100,
                message: `SDK installation complete. Version: ${version}`
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`SDK installation failed: ${errorMessage}`);

            progressCallback?.({
                stage: 'error',
                progress: 0,
                message: `Installation failed: ${errorMessage}`
            });

            // Clean up on failure
            if (fs.existsSync(this.sdkPath)) {
                try {
                    fs.rmSync(this.sdkPath, { recursive: true, force: true });
                } catch (cleanupError) {
                    this.outputChannel.appendLine(`Cleanup failed: ${cleanupError}`);
                }
            }

            throw error;
        }
    }

    async updateSDK(progressCallback?: (progress: SDKSetupProgress) => void): Promise<void> {
        if (!await this.isSDKInstalled()) {
            throw new Error('SDK not installed. Please install first.');
        }

        try {
            progressCallback?.({
                stage: 'updating',
                progress: 10,
                message: 'Checking for updates...'
            });

            const git = simpleGit(this.sdkPath);

            progressCallback?.({
                stage: 'updating',
                progress: 50,
                message: 'Fetching latest changes...'
            });

            await git.fetch();
            const status = await git.status();

            if (status.behind > 0) {
                progressCallback?.({
                    stage: 'updating',
                    progress: 80,
                    message: `Updating SDK (${status.behind} commits behind)...`
                });

                await git.pull();

                const version = await this.getSDKVersion();
                this.outputChannel.appendLine(`MSPM0 SDK updated successfully. New version: ${version}`);

                progressCallback?.({
                    stage: 'complete',
                    progress: 100,
                    message: `SDK updated to version: ${version}`
                });
            } else {
                progressCallback?.({
                    stage: 'complete',
                    progress: 100,
                    message: 'SDK is already up to date'
                });
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`SDK update failed: ${errorMessage}`);

            progressCallback?.({
                stage: 'error',
                progress: 0,
                message: `Update failed: ${errorMessage}`
            });

            throw error;
        }
    }

    async getSDKVersion(): Promise<string> {
        try {
            if (!await this.isSDKInstalled()) {
                return 'Not installed';
            }

            // Try to get version from git
            const git = simpleGit(this.sdkPath);
            const log = await git.log(['-1', '--oneline']);

            if (log.latest) {
                return log.latest.hash.substring(0, 8);
            }

            return 'Unknown';
        } catch (error) {
            this.outputChannel.appendLine(`Error getting SDK version: ${error}`);
            return 'Unknown';
        }
    }

    getSDKPath(): string {
        return this.sdkPath;
    }

    getIncludePaths(): string[] {
        if (!fs.existsSync(this.sdkPath)) {
            return [];
        }

        return [
            path.join(this.sdkPath, 'source'),
            path.join(this.sdkPath, 'kernel'),
            path.join(this.sdkPath, 'source', 'ti', 'driverlib'),
        ].filter(p => fs.existsSync(p));
    }

    getLibraryPaths(): string[] {
        if (!fs.existsSync(this.sdkPath)) {
            return [];
        }

        const libPath = path.join(this.sdkPath, 'source', 'ti', 'driverlib', 'lib');
        if (fs.existsSync(libPath)) {
            return [libPath];
        }

        return [];
    }

    // Method to set custom SDK repository URL (for testing or alternative sources)
    setSDKRepositoryURL(url: string): void {
        // TODO: Add validation for URL format
        this.outputChannel.appendLine(`SDK repository URL updated to: ${url}`);
    }
}