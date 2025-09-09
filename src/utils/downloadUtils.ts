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
            let fileStream: fs.WriteStream | null = null;
            try {
                this.outputChannel.appendLine(`Starting download: ${url}`);
                this.outputChannel.appendLine(`Destination: ${destinationPath}`);

                const destinationDir = path.dirname(destinationPath);
                if (!fs.existsSync(destinationDir)) {
                    fs.mkdirSync(destinationDir, { recursive: true });
                }

                const response = await fetch(url, {
                    headers: { 'User-Agent': this.getUserAgent() }
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const totalBytesStr = response.headers.get('content-length');
                if (!totalBytesStr) {
                    this.outputChannel.appendLine('Warning: Server did not provide Content-Length. Cannot verify file size.');
                }
                const totalBytes = parseInt(totalBytesStr || '0', 10);
                
                let downloadedBytes = 0;
                
                fileStream = fs.createWriteStream(destinationPath);
                
                if (!response.body) {
                    throw new Error('Response body is null');
                }
                
                response.body.pipe(fileStream);

                let lastProgressTime = Date.now();
                let lastDownloadedBytes = 0;

                response.body.on('data', (chunk: Buffer) => {
                    downloadedBytes += chunk.length;
                    
                    // Calculate progress and speed
                    if (totalBytes > 0) {
                        const percentage = (downloadedBytes / totalBytes) * 100;
                        const currentTime = Date.now();
                        const timeDiff = currentTime - lastProgressTime;

                        if (timeDiff >= 250) {
                            const bytesDiff = downloadedBytes - lastDownloadedBytes;
                            const speed = (bytesDiff / timeDiff) * 1000; // bytes per second

                            this.outputChannel.appendLine(
                                `Download progress: ${percentage.toFixed(1)}% ` +
                                `(${this.formatBytes(downloadedBytes)}/${this.formatBytes(totalBytes)}) ` +
                                `at ${this.formatBytes(speed)}/s`
                            );

                            progressCallback?.(percentage > 100 ? 100 : percentage);

                            lastProgressTime = currentTime;
                            lastDownloadedBytes = downloadedBytes;
                        }
                    }
                });

                response.body.on('error', (error) => {
                    this.outputChannel.appendLine(`Download stream error: ${error.message}`);
                    fileStream?.close(); // Ensure file stream is closed
                    reject(error);
                });

                fileStream.on('error', (error) => {
                    // Use type assertion since we can't check if destroy exists
                    (response.body as any)?.destroy?.();
                    reject(error);
                });

                fileStream.on('finish', () => {
                    this.outputChannel.appendLine(`Download stream finished. Verifying file size...`);
                    
                    try {
                        const actualSize = fs.statSync(destinationPath).size;
                        
                        // Verify the file size if the server provided it
                        if (totalBytes > 0 && actualSize !== totalBytes) {
                            const errorMsg = `Download corrupted. Expected ${totalBytes} bytes but received ${actualSize} bytes.`;
                            this.outputChannel.appendLine(`ERROR: ${errorMsg}`);
                            reject(new Error(errorMsg));
                        } else {
                            this.outputChannel.appendLine(`✅ Download complete and verified: ${this.formatBytes(actualSize)} total`);
                            progressCallback?.(100);
                            resolve();
                        }
                    } catch (statError) {
                        reject(new Error(`Failed to verify file size after download: ${statError}`));
                    }
                });
            } catch (error) {
                // This top-level catch handles errors from the initial `fetch` call
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.outputChannel.appendLine(`Download failed: ${errorMessage}`);
                
                // Ensure stream is closed and partial file is deleted
                fileStream?.close(); 
                if (fs.existsSync(destinationPath)) {
                    try {
                        fs.unlinkSync(destinationPath);
                    } catch (cleanupError) {
                        // Ignore cleanup errors
                    }
                }
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
                method: 'HEAD',
                headers: { 'User-Agent': this.getUserAgent() }
            });
            return response.ok;
        } catch (error) {
            this.outputChannel.appendLine(`Connectivity check failed: ${error}`);
            return false;
        }
    }

    async getFileSize(url: string): Promise<number> {
        try {
            const response = await fetch(url, { 
                method: 'HEAD',
                headers: { 'User-Agent': this.getUserAgent() }
            });
            
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
        if (bytes === 0) {return '0 B';}
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(1))} ${units[i]}`;
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