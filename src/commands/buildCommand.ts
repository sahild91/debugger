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

export class BuildCommand {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private sdkManager: SDKManager;
    private toolchainManager: ToolchainManager;
    private sysConfigManager: SysConfigManager;
    private buildProcess: ChildProcess | null = null;
    private diagnosticCollection: vscode.DiagnosticCollection;

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
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('port11-debugger');
        
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

    async execute(options: BuildOptions = {}): Promise<BuildResult> {
        const startTime = Date.now();
        
        try {
            this.outputChannel.appendLine('='.repeat(50));
            this.outputChannel.appendLine('Starting build process...');
            this.outputChannel.appendLine('='.repeat(50));

            // Validate prerequisites
            await this.validatePrerequisites();

            // Find project files
            const projectInfo = await this.detectProject();
            if (!projectInfo) {
                throw new Error('No valid MSPM0 project found in workspace');
            }

            // Clear previous diagnostics
            this.diagnosticCollection.clear();

            // Prepare build environment
            const buildConfig = await this.prepareBuildConfig(projectInfo, options);

            // Execute build
            const result = await this.executeBuild(buildConfig);
            
            const buildTime = Date.now() - startTime;
            result.buildTime = buildTime;

            // Show build results
            this.showBuildResults(result);

            return result;

        } catch (error) {
            const buildTime = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            this.outputChannel.appendLine(`Build failed: ${errorMessage}`);
            
            const result: BuildResult = {
                success: false,
                errors: [{
                    message: errorMessage,
                    range: new vscode.Range(0, 0, 0, 0),
                    severity: vscode.DiagnosticSeverity.Error,
                    source: 'port11-debugger'
                }],
                warnings: [],
                buildTime
            };

            this.showBuildResults(result);
            return result;
        }
    }

    async stop(): Promise<void> {
        if (this.buildProcess) {
            this.outputChannel.appendLine('Stopping build process...');
            this.buildProcess.kill();
            this.buildProcess = null;
        }
    }

    private async validatePrerequisites(): Promise<void> {
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
        return new Promise((resolve, reject) => {
            // Ensure output directory exists
            if (!fs.existsSync(config.outputPath)) {
                fs.mkdirSync(config.outputPath, { recursive: true });
            }

            // Prepare compiler arguments
            const args = this.buildCompilerArgs(config);
            
            this.outputChannel.appendLine(`Executing: ${config.compilerPath} ${args.join(' ')}`);

            // Start build process
            this.buildProcess = spawn(config.compilerPath, args, {
                cwd: config.projectPath,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            this.buildProcess.stdout?.on('data', (data) => {
                const output = data.toString();
                stdout += output;
                this.outputChannel.append(output);
            });

            this.buildProcess.stderr?.on('data', (data) => {
                const output = data.toString();
                stderr += output;
                this.outputChannel.append(output);
            });

            this.buildProcess.on('close', (code) => {
                this.buildProcess = null;

                // Parse build output for errors and warnings
                const diagnostics = this.parseBuildOutput(stdout + stderr, config.projectPath);
                
                const result: BuildResult = {
                    success: code === 0,
                    errors: diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error),
                    warnings: diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning),
                    outputPath: code === 0 ? path.join(config.outputPath, 'main.out') : undefined,
                    buildTime: 0 // Will be set by caller
                };

                // Update diagnostics collection
                this.updateDiagnostics(diagnostics);

                if (code === 0) {
                    this.outputChannel.appendLine('Build completed successfully');
                } else {
                    this.outputChannel.appendLine(`Build failed with exit code ${code}`);
                }

                resolve(result);
            });

            this.buildProcess.on('error', (error) => {
                this.buildProcess = null;
                reject(new Error(`Build process error: ${error.message}`));
            });
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
    }
}