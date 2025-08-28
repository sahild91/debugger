import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { SDKManager } from '../managers/sdkManager';
import { ToolchainManager } from '../managers/toolchainManager';
import { SysConfigManager } from '../managers/sysconfigManager';

export interface BuildOptions {
    target?: string;
    optimization?: 'debug' | 'release';
    verbose?: boolean;
    clean?: boolean;
}

export interface BuildResult {
    success: boolean;
    errors: vscode.Diagnostic[];
    warnings: vscode.Diagnostic[];
    outputPath?: string;
    buildTime: number;
}

export interface BuildProgress {
    stage: 'setup' | 'sysconfig' | 'compile' | 'link' | 'complete' | 'error';
    message: string;
    percentage: number;
    elapsedTime: number;
    currentFile?: string;
}

export class BuildCommand {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private sdkManager: SDKManager;
    private toolchainManager: ToolchainManager;
    private sysConfigManager: SysConfigManager;
    private buildProcess: ChildProcess | null = null;
    private diagnosticCollection: vscode.DiagnosticCollection;

    private buildStartTime: number = 0;
    private currentStage: string = '';
    private progressCallback?: (progress: BuildProgress) => void;
    private statusBarItem: vscode.StatusBarItem;

    constructor(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel,
        sdkManager: SDKManager,
        toolchainManager: ToolchainManager,
        sysConfigManager: SysConfigManager
    ) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.sdkManager = sdkManager;
        this.toolchainManager = toolchainManager;
        this.sysConfigManager = sysConfigManager;
        console.log('BuildCommand using output channel:', this.outputChannel);
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('port11-debugger');

        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'port11-debugger.showLogs';
        
        context.subscriptions.push(this.diagnosticCollection);
    }

    private async validateSysConfigForBuild(): Promise<void> {
        if (!await this.sysConfigManager.isSysConfigInstalled()) {
            throw new Error('TI SysConfig not installed. Please run setup first.');
        }

        if (!await this.sysConfigManager.validateSysConfigForBuild()) {
            throw new Error('SysConfig CLI not functional. Please reinstall SysConfig.');
        }
    }

    setProgressCallback(callback: (progress: BuildProgress) => void): void {
        this.progressCallback = callback;
    }

    private updateProgress(stage: BuildProgress['stage'], message: string, percentage: number, currentFile?: string): void {
        const elapsedTime = Date.now() - this.buildStartTime;
        const progress: BuildProgress = {
            stage,
            message,
            percentage,
            elapsedTime,
            currentFile
        };

        // Update status bar
        this.statusBarItem.text = `$(sync~spin) ${message} (${percentage}%)`;
        this.statusBarItem.show();

        // Update output channel with timestamp
        const timestamp = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${timestamp}] ${this.getStageIcon(stage)} ${message}`);

        // Call progress callback for webview updates
        if (this.progressCallback) {
            this.progressCallback(progress);
        }

        this.currentStage = stage;
    }

    private getStageIcon(stage: BuildProgress['stage']): string {
        switch (stage) {
            case 'setup': return '🔧';
            case 'sysconfig': return '⚙️';
            case 'compile': return '🔨';
            case 'link': return '🔗';
            case 'complete': return '✅';
            case 'error': return '❌';
            default: return '📝';
        }
    }

    private hideProgress(): void {
        this.statusBarItem.hide();
    }

    async cancelBuild(): Promise<void> {
        if (this.buildProcess) {
            this.updateProgress('error', 'Cancelling build process', 100);
            this.outputChannel.appendLine('🛑 Build cancelled by user');
            
            this.buildProcess.kill('SIGTERM');
            
            // Force kill after 5 seconds if it doesn't respond
            setTimeout(() => {
                if (this.buildProcess && !this.buildProcess.killed) {
                    this.buildProcess.kill('SIGKILL');
                }
            }, 5000);
            
            this.buildProcess = null;
            this.hideProgress();
            
            vscode.window.showWarningMessage('Build process cancelled');
        }
    }

    async execute(options: BuildOptions = {}): Promise<BuildResult> {
        // Prevent multiple concurrent builds
        if (this.buildProcess) {
            console.log('🔥 BUILD EXECUTE EXCEPTION: Build Process is not available.')
            throw new Error('Build already in progress. Use "Cancel Build" to stop the current build.');
        }
        console.log('🔥 BUILD EXECUTE CALLED');
        console.log('🔥 OUTPUT CHANNEL:', this.outputChannel);
        this.outputChannel.show(true);  // Force reveal
        this.outputChannel.appendLine('='.repeat(50));
        this.outputChannel.appendLine('🚀 DEBUG: Build command execute() called');
        this.outputChannel.appendLine(`🚀 DEBUG: Options: ${JSON.stringify(options)}`);
        this.outputChannel.appendLine('='.repeat(50));

        this.buildStartTime = Date.now();

        try {
            this.updateProgress('setup', 'Initializing build process', 0);

            // Clear previous diagnostics
            this.diagnosticCollection.clear();

            // Show output channel
            this.outputChannel.show(true);
            this.outputChannel.appendLine('='.repeat(80));
            this.outputChannel.appendLine('🚀 MSPM0 BUILD PROCESS STARTING');
            this.outputChannel.appendLine('='.repeat(80));

            // Stage 1: Setup and validation (0-15%)
            this.updateProgress('setup', 'Validating build prerequisites', 5);
            await this.validateBuildPrerequisites();

            this.updateProgress('setup', 'Detecting project structure', 10);
            const projectInfo = await this.detectProject();
            if (!projectInfo) {
                throw new Error('No MSPM0 project found in workspace');
            }

            this.updateProgress('setup', 'Preparing build configuration', 15);
            const buildConfig = await this.prepareBuildConfig(projectInfo, options);

            this.outputChannel.appendLine(`📁 Project: ${path.basename(projectInfo.rootPath)} (${projectInfo.rootPath})`);
            this.outputChannel.appendLine(`🔧 Toolchain: ${path.basename(buildConfig.compilerPath)}`);
            this.outputChannel.appendLine(`⚙️ Mode: ${options.optimization === 'release' ? 'Release' : 'Debug'}`);
            this.outputChannel.appendLine(`📄 Source Files: ${buildConfig.sourceFiles.length}`);
            this.outputChannel.appendLine('');

            let currentProgress = 15;

            // Stage 2: SysConfig generation if needed (15-35%)
            if (projectInfo.hasSysConfig) {
                this.updateProgress('sysconfig', 'Running SysConfig generation', 20);
                await this.runSysConfigGeneration(buildConfig);
                currentProgress = 35;
                this.outputChannel.appendLine('✅ SysConfig generation completed\n');
            }

            // Stage 3: Compilation (35-100%)
            this.updateProgress('compile', 'Starting compilation', currentProgress);
            const buildResult = await this.executeBuild(buildConfig);

            const totalTime = Date.now() - this.buildStartTime;
            buildResult.buildTime = totalTime;

            // Final status
            if (buildResult.success) {
                this.updateProgress('complete', `Build successful in ${(totalTime / 1000).toFixed(1)}s`, 100);
                
                vscode.window.showInformationMessage(
                    `Build completed successfully in ${(totalTime / 1000).toFixed(1)}s`,
                    'Flash Firmware',
                    'Start Debug'
                ).then(selection => {
                    if (selection === 'Flash Firmware') {
                        vscode.commands.executeCommand('port11-debugger.flash');
                    } else if (selection === 'Start Debug') {
                        vscode.commands.executeCommand('port11-debugger.debug.start');
                    }
                });
            } else {
                this.updateProgress('error', `Build failed with ${buildResult.errors.length} errors`, 100);
                
                vscode.window.showErrorMessage(
                    `Build failed with ${buildResult.errors.length} errors`,
                    'Show Problems',
                    'View Output'
                ).then(selection => {
                    if (selection === 'Show Problems') {
                        vscode.commands.executeCommand('workbench.panel.markers.view.focus');
                    } else if (selection === 'View Output') {
                        this.outputChannel.show();
                    }
                });
            }

            // Hide progress after delay
            setTimeout(() => this.hideProgress(), 2000);

            return buildResult;

        } catch (error) {
            this.updateProgress('error', `Build failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 100);
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`❌ Build Error: ${errorMessage}`);
            this.outputChannel.appendLine('='.repeat(80));
            
            setTimeout(() => this.hideProgress(), 2000);
            throw error;
        } finally {
            this.buildProcess = null;
        }
    }

    async stop(): Promise<void> {
        if (this.buildProcess) {
            this.outputChannel.appendLine('Stopping build process...');
            this.buildProcess.kill();
            this.buildProcess = null;
        }
    }

    private async validateBuildPrerequisites(): Promise<void> {
        // Check if SDK is installed
        if (!await this.sdkManager.isSDKInstalled()) {
            throw new Error('MSPM0 SDK not installed. Please run setup first.');
        }

        // Check if toolchain is installed
        if (!await this.toolchainManager.isToolchainInstalled()) {
            throw new Error('ARM-CGT-CLANG toolchain not installed. Please run setup first.');
        }

        // Check if SysConfig is installed and functional
        await this.validateSysConfigForBuild();

        // Check if workspace is available
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            throw new Error('No workspace folder open');
        }
    }
    
    getSysConfigCliPath(): string {
        return this.sysConfigManager.getSysConfigCliPath();
    }

    private async detectProject(): Promise<any> {
        const workspaceFolders = vscode.workspace.workspaceFolders!;
        
        for (const folder of workspaceFolders) {
            const folderPath = folder.uri.fsPath;
            
            // Look for common MSPM0 project indicators
            const indicators = [
                'main.c',
                'ti_msp_dl_config.c',
                'ti_msp_dl_config.h',
                'makefile',
                'Makefile',
                '*.syscfg'
            ];

            let foundIndicators = 0;
            const projectFiles: string[] = [];

            for (const indicator of indicators) {
                const files = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(folder, indicator),
                    null,
                    10
                );
                
                if (files.length > 0) {
                    foundIndicators++;
                    projectFiles.push(...files.map(f => f.fsPath));
                }
            }

            // If we found at least 2 indicators, consider it a valid project
            if (foundIndicators >= 2) {
                return {
                    rootPath: folderPath,
                    projectFiles,
                    hasMain: projectFiles.some(f => f.endsWith('main.c')),
                    hasMakeFile: projectFiles.some(f => f.toLowerCase().includes('makefile')),
                    hasSysConfig: projectFiles.some(f => f.endsWith('.syscfg'))
                };
            }
        }

        return null;
    }

    private async prepareBuildConfig(projectInfo: any, options: BuildOptions): Promise<any> {
        const compilerPath = this.toolchainManager.getCompilerPath();
        if (!compilerPath) {
            throw new Error('Compiler not found');
        }

        const sdkPath = this.sdkManager.getSDKPath();
        const includePaths = [
            ...this.sdkManager.getIncludePaths(),
            ...this.toolchainManager.getIncludePaths()
        ];
        
        const libraryPaths = [
            ...this.sdkManager.getLibraryPaths(),
            ...this.toolchainManager.getLibraryPaths()
        ];

        return {
            projectPath: projectInfo.rootPath,
            compilerPath,
            sdkPath,
            includePaths,
            libraryPaths,
            sourceFiles: await this.findSourceFiles(projectInfo.rootPath),
            optimization: options.optimization || 'debug',
            verbose: options.verbose || false,
            outputPath: path.join(projectInfo.rootPath, 'build')
        };
    }

    private async findSourceFiles(rootPath: string): Promise<string[]> {
        const sourceFiles: string[] = [];
        const patterns = ['**/*.c', '**/*.cpp', '**/*.cc'];

        for (const pattern of patterns) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(rootPath, pattern),
                '**/build/**', // Exclude build directory
                100
            );
            
            sourceFiles.push(...files.map(f => f.fsPath));
        }

        return sourceFiles;
    }

    private async executeBuild(config: any): Promise<BuildResult> {
        return new Promise(async (resolve, reject) => {
            try {
                // Ensure output directory exists
                if (!fs.existsSync(config.outputPath)) {
                    fs.mkdirSync(config.outputPath, { recursive: true });
                }

                const args = this.buildCompilerArgs(config);
                this.outputChannel.appendLine(`🔨 Executing: ${path.basename(config.compilerPath)} ${args.join(' ')}`);
                this.outputChannel.appendLine('');

                // Start build process
                this.buildProcess = spawn(config.compilerPath, args, {
                    cwd: config.projectPath,
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                let stdout = '';
                let stderr = '';
                let currentFileIndex = 0;
                const totalFiles = config.sourceFiles.length;

                this.buildProcess.stdout?.on('data', (data) => {
                    const output = data.toString();
                    stdout += output;
                    
                    // Parse output for file progress
                    const lines = output.split('\n');
                    lines.forEach((line: string) => {
                        if (line.trim()) {
                            this.outputChannel.appendLine(`  📝 ${line.trim()}`);
                            
                            // Try to extract current file being compiled
                            const fileMatch = line.match(/(\w+\.c|\w+\.cpp)/);
                            if (fileMatch) {
                                currentFileIndex++;
                                const progress = Math.min(95, 35 + ((currentFileIndex / totalFiles) * 60)); // 35-95%
                                this.updateProgress('compile', `Compiling: ${fileMatch[1]}`, progress, fileMatch[1]);
                            }
                        }
                    });
                });

                this.buildProcess.stderr?.on('data', (data) => {
                    const output = data.toString();
                    stderr += output;
                    
                    const lines = output.split('\n');
                    lines.forEach((line: string) => {
                        if (line.trim()) {
                            if (line.toLowerCase().includes('error')) {
                                this.outputChannel.appendLine(`  ❌ ${line.trim()}`);
                            } else if (line.toLowerCase().includes('warning')) {
                                this.outputChannel.appendLine(`  ⚠️  ${line.trim()}`);
                            } else {
                                this.outputChannel.appendLine(`  📝 ${line.trim()}`);
                            }
                        }
                    });
                });

                this.buildProcess.on('close', (code) => {
                    this.buildProcess = null;

                    this.outputChannel.appendLine('');
                    this.outputChannel.appendLine('📊 BUILD RESULTS');
                    this.outputChannel.appendLine('-'.repeat(30));

                    // Parse build output for errors and warnings
                    const diagnostics = this.parseBuildOutput(stdout + stderr, config.projectPath);
                    const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                    const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);

                    const result: BuildResult = {
                        success: code === 0 && errors.length === 0,
                        errors: errors,
                        warnings: warnings,
                        outputPath: code === 0 ? path.join(config.outputPath, 'main.out') : undefined,
                        buildTime: 0 // Will be set by caller
                    };

                    // Update diagnostics collection
                    this.updateDiagnostics(diagnostics);

                    // Show detailed results
                    if (code === 0) {
                        this.outputChannel.appendLine(`✅ BUILD SUCCESSFUL`);
                        this.outputChannel.appendLine(`   • Output File: ${result.outputPath}`);
                        if (result.outputPath && fs.existsSync(result.outputPath)) {
                            const stats = fs.statSync(result.outputPath);
                            this.outputChannel.appendLine(`   • File Size: ${(stats.size / 1024).toFixed(2)} KB`);
                        }
                    } else {
                        this.outputChannel.appendLine(`❌ BUILD FAILED (Exit Code: ${code})`);
                    }

                    this.outputChannel.appendLine(`   • Errors: ${errors.length}`);
                    this.outputChannel.appendLine(`   • Warnings: ${warnings.length}`);

                    // Show specific errors and warnings
                    if (errors.length > 0) {
                        this.outputChannel.appendLine('');
                        this.outputChannel.appendLine('❌ ERRORS:');
                        errors.slice(0, 5).forEach((error, index) => {
                            this.outputChannel.appendLine(`   ${index + 1}. ${error.message}`);
                        });
                        if (errors.length > 5) {
                            this.outputChannel.appendLine(`   ... and ${errors.length - 5} more errors`);
                        }
                    }

                    if (warnings.length > 0) {
                        this.outputChannel.appendLine('');
                        this.outputChannel.appendLine('⚠️  WARNINGS:');
                        warnings.slice(0, 3).forEach((warning, index) => {
                            this.outputChannel.appendLine(`   ${index + 1}. ${warning.message}`);
                        });
                        if (warnings.length > 3) {
                            this.outputChannel.appendLine(`   ... and ${warnings.length - 3} more warnings`);
                        }
                    }

                    this.outputChannel.appendLine('');
                    this.outputChannel.appendLine('🚀 NEXT STEPS:');
                    if (code === 0) {
                        this.outputChannel.appendLine('   • Use "Flash Firmware" to program your board');
                        this.outputChannel.appendLine('   • Use "Start Debug" to begin debugging session');
                    } else {
                        this.outputChannel.appendLine('   • Check the Problems panel for detailed error locations');
                        this.outputChannel.appendLine('   • Verify all source files compile individually');
                        this.outputChannel.appendLine('   • Check include paths and library dependencies');
                    }

                    this.outputChannel.appendLine('='.repeat(80));
                    resolve(result);
                });

                this.buildProcess.on('error', (error) => {
                    this.buildProcess = null;
                    reject(new Error(`Build process error: ${error.message}`));
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    private async runSysConfigGeneration(config: any): Promise<void> {
        const sysConfigFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(config.projectPath, '**/*.syscfg'),
            null,
            10
        );

        if (sysConfigFiles.length === 0) {
            this.outputChannel.appendLine('No .syscfg files found, skipping SysConfig generation');
            return;
        }

        const sysConfigCliPath = this.sysConfigManager.getSysConfigCliPath();
        
        for (const sysConfigFile of sysConfigFiles) {
            const sysConfigFilePath = sysConfigFile.fsPath;
            const fileName = path.basename(sysConfigFilePath);
            
            this.outputChannel.appendLine(`🔧 Processing SysConfig file: ${fileName}`);
            
            const args = [
                '-c', sysConfigFilePath,
                '-o', path.dirname(sysConfigFilePath),
                '--compiler', 'ccs'
            ];

            await this.runSysConfigCLI(sysConfigCliPath, args, path.dirname(sysConfigFilePath));
        }
    }

    private async runSysConfigCLI(sysConfigCliPath: string, args: string[], cwd: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const platform = require('os').platform();
            let sysConfigProcess;

            if (platform.startsWith('win32') && sysConfigCliPath.endsWith('.bat')) {
                // Windows batch file
                sysConfigProcess = spawn('cmd', ['/c', `"${sysConfigCliPath}"`, ...args], {
                    cwd: cwd,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true
                });
            } else {
                // Direct execution
                sysConfigProcess = spawn(sysConfigCliPath, args, {
                    cwd: cwd,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            }

            sysConfigProcess.stdout?.on('data', (data) => {
                const output = data.toString();
                const lines = output.split('\n');
                lines.forEach((line: string) => {
                    if (line.trim()) {
                        this.outputChannel.appendLine(`  🔧 ${line.trim()}`);
                    }
                });
            });

            sysConfigProcess.stderr?.on('data', (data) => {
                const output = data.toString();
                const lines = output.split('\n');
                lines.forEach((line: string) => {
                    if (line.trim()) {
                        this.outputChannel.appendLine(`  ⚠️  ${line.trim()}`);
                    }
                });
            });

            sysConfigProcess.on('close', (code) => {
                if (code === 0) {
                    this.outputChannel.appendLine('  ✅ SysConfig code generation completed');
                    this.outputChannel.appendLine('');
                    resolve();
                } else {
                    this.outputChannel.appendLine(`  ❌ SysConfig generation failed (Exit Code: ${code})`);
                    this.outputChannel.appendLine('');
                    reject(new Error(`SysConfig generation failed with exit code ${code}`));
                }
            });

            sysConfigProcess.on('error', (error) => {
                this.outputChannel.appendLine(`  ❌ SysConfig error: ${error.message}`);
                reject(error);
            });

            // Timeout after 30 seconds
            setTimeout(() => {
                if (!sysConfigProcess.killed) {
                    sysConfigProcess.kill();
                    reject(new Error('SysConfig generation timed out'));
                }
            }, 30000);
        });
    }

    private buildCompilerArgs(config: any): string[] {
        const args: string[] = [];

        // Basic compiler flags
        args.push('--silicon_version=7M0P');
        args.push('--code_state=16');
        args.push('--float_support=none');

        // Optimization
        if (config.optimization === 'debug') {
            args.push('-g');
            args.push('--opt_level=0');
        } else {
            args.push('--opt_level=2');
        }

        // Include paths
        config.includePaths.forEach((includePath: string) => {
            args.push(`-I"${includePath}"`);
        });

        // Define common macros
        args.push('-D__MSPM0G3507__');
        
        // Source files
        config.sourceFiles.forEach((sourceFile: string) => {
            args.push(`"${sourceFile}"`);
        });

        // Output file
        args.push(`--output_file="${path.join(config.outputPath, 'main.out')}"`);

        // Library paths
        config.libraryPaths.forEach((libPath: string) => {
            args.push(`-i"${libPath}"`);
        });

        if (config.verbose) {
            args.push('--verbose');
        }

        return args;
    }

    private parseBuildOutput(output: string, projectPath: string): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        const lines = output.split('\n');

        for (const line of lines) {
            // Parse ARM-CGT-CLANG error/warning format
            // Format: "file.c", line X: error/warning #XXXX: message
            const match = line.match(/"([^"]+)",\s*line\s*(\d+):\s*(error|warning)\s*#?\d*:\s*(.+)/i);
            
            if (match) {
                const [, filePath, lineNum, severity, message] = match;
                const fullPath = path.resolve(projectPath, filePath);
                
                const diagnostic: vscode.Diagnostic = {
                    range: new vscode.Range(
                        Math.max(0, parseInt(lineNum) - 1), 0,
                        Math.max(0, parseInt(lineNum) - 1), 1000
                    ),
                    message: message.trim(),
                    severity: severity.toLowerCase() === 'error' ? 
                        vscode.DiagnosticSeverity.Error : 
                        vscode.DiagnosticSeverity.Warning,
                    source: 'port11-debugger'
                };

                diagnostics.push(diagnostic);
            }
        }

        return diagnostics;
    }

    private updateDiagnostics(diagnostics: vscode.Diagnostic[]): void {
        // Group diagnostics by file
        const diagnosticMap = new Map<string, vscode.Diagnostic[]>();

        for (const diagnostic of diagnostics) {
            // Extract file path from diagnostic (this is simplified)
            const filePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath + '/main.c'; // Placeholder
            
            if (!diagnosticMap.has(filePath)) {
                diagnosticMap.set(filePath, []);
            }
            diagnosticMap.get(filePath)!.push(diagnostic);
        }

        // Update diagnostics for each file
        for (const [filePath, fileDiagnostics] of diagnosticMap) {
            const uri = vscode.Uri.file(filePath);
            this.diagnosticCollection.set(uri, fileDiagnostics);
        }
    }

    private showBuildResults(result: BuildResult): void {
        const { success, errors, warnings, buildTime } = result;
        
        if (success) {
            vscode.window.showInformationMessage(
                `Build completed successfully in ${(buildTime / 1000).toFixed(1)}s ` +
                `(${warnings.length} warnings)`
            );
        } else {
            vscode.window.showErrorMessage(
                `Build failed with ${errors.length} errors and ${warnings.length} warnings`
            );
        }

        // Focus problems panel if there are errors
        if (errors.length > 0) {
            vscode.commands.executeCommand('workbench.panel.markers.view.focus');
        }
    }

    dispose(): void {
        if (this.buildProcess) {
            this.buildProcess.kill();
        }
        this.diagnosticCollection.dispose();
        this.statusBarItem.dispose();
    }
}