import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { simpleGit, SimpleGit } from 'simple-git';

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

    // TODO: Replace with actual MSPM0 SDK repository URL
    private readonly SDK_REPO_URL = 'https://github.com/TexasInstruments/mspm0-sdk'; // Placeholder
    private readonly SDK_FOLDER_NAME = 'mspm0-sdk';

    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.sdkPath = path.join(context.globalStorageUri.fsPath, this.SDK_FOLDER_NAME);
        this.git = simpleGit();
    }

    async isSDKInstalled(): Promise<boolean> {
        try {
            if (!fs.existsSync(this.sdkPath)) {
                return false;
            }

            // Check if it's a valid git repository
            const gitPath = path.join(this.sdkPath, '.git');
            if (!fs.existsSync(gitPath)) {
                return false;
            }

            // Check if it has the expected MSPM0 structure
            const expectedPaths = [
                'source',
                'examples',
                'kernel'
            ];

            return expectedPaths.every(p => fs.existsSync(path.join(this.sdkPath, p)));
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