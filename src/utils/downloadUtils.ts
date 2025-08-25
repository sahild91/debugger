import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';

export interface DownloadProgress {
    totalBytes: number;
    downloadedBytes: number;
    percentage: number;
    speed: number; // bytes per second
}

export class DownloadUtils {
    private outputChannel: vscode.OutputChannel;
    
    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    async downloadFile(
        url: string, 
        destinationPath: string, 
        progressCallback?: (progress: number) => void
    ): Promise<void> {
        return new Promise(async (resolve, reject) => {
            try {
                this.outputChannel.appendLine(`Starting download: ${url}`);
                this.outputChannel.appendLine(`Destination: ${destinationPath}`);

                // Ensure destination directory exists
                const destinationDir = path.dirname(destinationPath);
                if (!fs.existsSync(destinationDir)) {
                    fs.mkdirSync(destinationDir, { recursive: true });
                }

                const response = await fetch(url);
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);
                let downloadedBytes = 0;
                
                const fileStream = fs.createWriteStream(destinationPath);
                let lastProgressTime = Date.now();
                let lastDownloadedBytes = 0;

                if (!response.body) {
                    throw new Error('Response body is null');
                }

                // Handle the readable stream properly
                response.body.on('data', (chunk: Buffer) => {
                    downloadedBytes += chunk.length;
                    fileStream.write(chunk);

                    // Calculate progress and speed
                    if (totalBytes > 0) {
                        const percentage = (downloadedBytes / totalBytes) * 100;
                        const currentTime = Date.now();
                        const timeDiff = currentTime - lastProgressTime;

                        // Update progress every 100ms to avoid too frequent updates
                        if (timeDiff >= 100) {
                            const bytesDiff = downloadedBytes - lastDownloadedBytes;
                            const speed = (bytesDiff / timeDiff) * 1000; // bytes per second

                            this.outputChannel.appendLine(
                                `Download progress: ${percentage.toFixed(1)}% ` +
                                `(${this.formatBytes(downloadedBytes)}/${this.formatBytes(totalBytes)}) ` +
                                `at ${this.formatBytes(speed)}/s`
                            );

                            progressCallback?.(percentage);

                            lastProgressTime = currentTime;
                            lastDownloadedBytes = downloadedBytes;
                        }
                    }
                });

                response.body.on('end', () => {
                    fileStream.end();
                    this.outputChannel.appendLine(`Download completed: ${this.formatBytes(downloadedBytes)} total`);
                    progressCallback?.(100);
                    resolve();
                });

                response.body.on('error', (error) => {
                    fileStream.destroy();
                    // Clean up partial file
                    try {
                        fs.unlinkSync(destinationPath);
                    } catch (cleanupError) {
                        this.outputChannel.appendLine(`Warning: Could not clean up partial download: ${cleanupError}`);
                    }
                    reject(error);
                });

                fileStream.on('error', (error) => {
                    // Use type assertion since we can't check if destroy exists
                    (response.body as any)?.destroy?.();
                    reject(error);
                });

            } catch (error) {
                // Clean up partial file
                try {
                    if (fs.existsSync(destinationPath)) {
                        fs.unlinkSync(destinationPath);
                    }
                } catch (cleanupError) {
                    this.outputChannel.appendLine(`Warning: Could not clean up failed download: ${cleanupError}`);
                }
                
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.outputChannel.appendLine(`Download failed: ${errorMessage}`);
                reject(error);
            }
        });
    }

    async downloadWithRetry(
        url: string,
        destinationPath: string,
        maxRetries: number = 3,
        progressCallback?: (progress: number) => void
    ): Promise<void> {
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.outputChannel.appendLine(`Download attempt ${attempt}/${maxRetries}`);
                
                await this.downloadFile(url, destinationPath, progressCallback);
                return; // Success, exit the retry loop
                
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                this.outputChannel.appendLine(`Attempt ${attempt} failed: ${lastError.message}`);
                
                if (attempt < maxRetries) {
                    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
                    this.outputChannel.appendLine(`Retrying in ${delayMs/1000}s...`);
                    await this.delay(delayMs);
                }
            }
        }

        // All retries failed
        throw lastError || new Error('Download failed after all retries');
    }

    async checkConnectivity(url?: string): Promise<boolean> {
        const testUrl = url || 'https://www.google.com';
        
        try {
            const response = await fetch(testUrl, { 
                method: 'HEAD'
                // Remove timeout property as it's not supported in node-fetch v3
            });
            return response.ok;
        } catch (error) {
            this.outputChannel.appendLine(`Connectivity check failed: ${error}`);
            return false;
        }
    }

    async getFileSize(url: string): Promise<number> {
        try {
            const response = await fetch(url, { method: 'HEAD' });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const contentLength = response.headers.get('content-length');
            return contentLength ? parseInt(contentLength, 10) : 0;
            
        } catch (error) {
            this.outputChannel.appendLine(`Error getting file size: ${error}`);
            return 0;
        }
    }

    private formatBytes(bytes: number): string {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(1)} ${units[unitIndex]}`;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Utility method to validate download URLs
    static isValidUrl(url: string): boolean {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }

    // Method to generate appropriate user agent string
    private getUserAgent(): string {
        return `Port11-Debugger-VSCode-Extension/0.1.0 (${process.platform})`;
    }
}