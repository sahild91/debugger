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
        if (stage === 'error') {
            this.statusBarItem.text = `$(error) ${message}`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (stage === 'complete') {
            this.statusBarItem.text = `$(check) Build completed (${(elapsedTime / 1000).toFixed(1)}s)`;
            this.statusBarItem.backgroundColor = undefined;
        } else {
            this.statusBarItem.text = `$(sync~spin) ${message} (${percentage}%)`;
            this.statusBarItem.backgroundColor = undefined;
        }
        this.statusBarItem.show();

        // Update output channel with timestamp and better formatting
        const timestamp = new Date().toLocaleTimeString();
        const stageIcon = this.getStageIcon(stage);
        
        if (stage === 'error') {
            this.outputChannel.appendLine(`[${timestamp}] ${stageIcon} ❌ BUILD FAILED: ${message}`);
            this.outputChannel.appendLine('Build process terminated due to error.');
        } else {
            this.outputChannel.appendLine(`[${timestamp}] ${stageIcon} ${message}`);
        }

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
            
            // First try graceful termination
            this.buildProcess.kill('SIGTERM');
            
            // Force kill after 3 seconds if it doesn't respond
            setTimeout(() => {
                if (this.buildProcess && !this.buildProcess.killed) {
                    this.outputChannel.appendLine('🔫 Force killing build process...');
                    this.buildProcess.kill('SIGKILL');
                }
            }, 3000);
            
            this.buildProcess = null;
            this.hideProgress();
            
            vscode.window.showWarningMessage('Build process cancelled');
        } else {
            this.outputChannel.appendLine('ℹ️  No active build process to cancel');
        }
    }

    async execute(options: BuildOptions = {}): Promise<BuildResult> {
        // Prevent multiple concurrent builds
        if (this.buildProcess) {
            throw new Error('Build already in progress. Use "Cancel Build" to stop the current build.');
        }

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
            try {
                await this.validateBuildPrerequisites();
            } catch (error) {
                this.updateProgress('error', 'Prerequisites validation failed', 100);
                throw error;  // Stop immediately on prerequisite failure
            }

            this.updateProgress('setup', 'Detecting project structure', 10);
            let projectInfo;
            try {
                projectInfo = await this.detectProject();
                if (!projectInfo) {
                    throw new Error('No MSPM0 project found in workspace. Please ensure you have a valid MSPM0 project with main.c and .syscfg files.');
                }
            } catch (error) {
                this.updateProgress('error', 'Project detection failed', 100);
                throw error;  // Stop immediately on project detection failure
            }

            this.updateProgress('setup', 'Preparing build configuration', 15);
            let buildConfig;
            try {
                buildConfig = await this.prepareBuildConfig(projectInfo, options);
            } catch (error) {
                this.updateProgress('error', 'Build configuration failed', 100);
                throw error;  // Stop immediately on config failure
            }

            this.outputChannel.appendLine(`📁 Project: ${path.basename(projectInfo.rootPath)} (${projectInfo.rootPath})`);
            this.outputChannel.appendLine(`🔧 Toolchain: ${path.basename(buildConfig.compilerPath)}`);
            this.outputChannel.appendLine(`⚙️ Mode: ${options.optimization === 'release' ? 'Release' : 'Debug'}`);
            this.outputChannel.appendLine('');

            // Stage 2: SysConfig generation (15-35%)
            this.updateProgress('sysconfig', 'Generating SysConfig files', 20);
            try {
                await this.runSysConfigGeneration();
            } catch (error) {
                this.updateProgress('error', 'SysConfig generation failed', 100);
                throw error;  // Stop immediately on SysConfig failure
            }

            // Stage 3: Compilation (35-95%)
            this.updateProgress('compile', 'Starting compilation', 35);
            try {
                const result = await this.executeBuild(buildConfig);
                this.updateProgress('complete', 'Build completed successfully', 100);
                return result;
            } catch (error) {
                this.updateProgress('error', 'Compilation failed', 100);
                throw error;  // Stop immediately on compilation failure
            }

        } catch (error) {
            // Enhanced error handling with immediate stop
            this.updateProgress('error', error instanceof Error ? error.message : 'Unknown error', 100);
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`❌ Build Error: ${errorMessage}`);
            this.outputChannel.appendLine('='.repeat(80));
            
            // Stop any running processes
            if (this.buildProcess && !(this.buildProcess as ChildProcess).killed) {
                this.outputChannel.appendLine('🛑 Terminating build process...');
                (this.buildProcess as ChildProcess).kill('SIGTERM');
                this.buildProcess = null;
            }
            
            // Hide progress and show final status
            setTimeout(() => this.hideProgress(), 1000);
            
            // Create and return failed build result
            const buildResult: BuildResult = {
                success: false,
                errors: [{
                    severity: vscode.DiagnosticSeverity.Error,
                    range: new vscode.Range(0, 0, 0, 0),
                    message: errorMessage,
                    source: 'port11-debugger'
                }],
                warnings: [],
                buildTime: Date.now() - this.buildStartTime
            };
            
            // Don't throw here - return the result instead so the UI can handle it gracefully
            return buildResult;
            
        } finally {
            // Always clean up
            this.buildProcess = null;
            this.hideProgress();
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
        
        this.outputChannel.appendLine('🔍 Searching for MSPM0 project indicators...');

        const projectFiles: string[] = [];
        
        for (const folder of workspaceFolders) {
            const folderPath = folder.uri.fsPath;
            this.outputChannel.appendLine(`   Checking folder: ${folderPath}`);
            
            // Look for essential MSPM0 project files
            const essentialFiles = [
                '*.c',           // C source files
                '*.syscfg'       // SysConfig files
            ];

            const optionalFiles = [
                'ti_msp_dl_config.c',
                'ti_msp_dl_config.h',
                'makefile',
                'Makefile'
            ];

            let foundEssential = 0;
            let foundOptional = 0;
            
            const foundFileTypes: string[] = [];

            // Check for essential files
            for (const pattern of essentialFiles) {
                const files = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(folder, pattern),
                    null,
                    10
                );
                
                if (files.length > 0) {
                    foundEssential++;
                    foundFileTypes.push(pattern);
                    projectFiles.push(...files.map(f => f.fsPath));
                    this.outputChannel.appendLine(`     ✅ Found ${files.length} ${pattern} file(s)`);
                } else {
                    this.outputChannel.appendLine(`     ❌ No ${pattern} files found`);
                }
            }

            // Check for optional files
            for (const pattern of optionalFiles) {
                const files = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(folder, pattern),
                    null,
                    5
                );
                
                if (files.length > 0) {
                    foundOptional++;
                    foundFileTypes.push(pattern);
                    projectFiles.push(...files.map(f => f.fsPath));
                    this.outputChannel.appendLine(`     ✅ Found ${files.length} ${pattern} file(s)`);
                }
            }

            // Require at least both essential file types (C files AND syscfg files)
            if (foundEssential >= 2) {  // Both *.c and *.syscfg must be present
                this.outputChannel.appendLine(`   ✅ Valid MSPM0 project detected in ${folderPath}`);
                this.outputChannel.appendLine(`      Essential files: ${foundEssential}/2, Optional files: ${foundOptional}`);
                
                return {
                    rootPath: folderPath,
                    projectFiles,
                    hasMain: projectFiles.some(f => f.endsWith('main.c')),
                    hasMakeFile: projectFiles.some(f => f.toLowerCase().includes('makefile')),
                    hasSysConfig: projectFiles.some(f => f.endsWith('.syscfg')),
                    foundFileTypes
                };
            } else {
                this.outputChannel.appendLine(`   ❌ Insufficient project files in ${folderPath}`);
                this.outputChannel.appendLine(`      Essential files found: ${foundEssential}/2 required`);
                this.outputChannel.appendLine(`      Missing: ${essentialFiles.filter((_, i) => !foundFileTypes.includes(essentialFiles[i])).join(', ')}`);
            }
        }

        // Provide helpful error message
        const missingRequirements = [];
        if (!projectFiles.some(f => f.endsWith('.c'))) {
            missingRequirements.push('C source files (*.c)');
        }
        if (!projectFiles.some(f => f.endsWith('.syscfg'))) {
            missingRequirements.push('SysConfig files (*.syscfg)');
        }

        throw new Error(
            `No valid MSPM0 project detected. Required files missing: ${missingRequirements.join(', ')}. ` +
            `Please ensure your workspace contains both C source files and SysConfig configuration files.`
        );
    }

    private async prepareBuildConfig(projectInfo: any, options: BuildOptions): Promise<any> {
        this.outputChannel.appendLine('🔧 Preparing build configuration...');
        
        // Get compiler path with detailed logging
        const compilerPath = this.toolchainManager.getCompilerPath();
        
        if (!compilerPath) {
            const errorMessage = `ARM-CGT-CLANG compiler not found!

    🚨 The extension could not find the TI ARM-CGT-CLANG compiler in any of these locations:

    1. Extension Storage: ${this.context.globalStorageUri.fsPath}
    2. System TI Installations (C:\\ti\\, /opt/ti/, etc.)
    3. System PATH

    💡 Solutions:
    1. Run "Port11 Debugger: Setup Toolchain" command to auto-install
    2. Manually install TI ARM-CGT-CLANG from: https://www.ti.com/tool/ARM-CGT
    3. Add existing installation to your system PATH

    🔧 Supported Versions: 3.2.1.LTS, 3.2.2.LTS, 4.0.2.LTS, 4.0.3.LTS`;

            throw new Error(errorMessage);
        }

        // Get other required paths
        const sdkPath = this.sdkManager.getSDKPath();
        if (!sdkPath || !fs.existsSync(sdkPath)) {
            throw new Error(`MSPM0 SDK not found. Please run setup first. Expected path: ${sdkPath}`);
        }

        const includePaths = [
            ...this.sdkManager.getIncludePaths(),
            ...this.toolchainManager.getIncludePaths()
        ];
        
        const libraryPaths = [
            ...this.sdkManager.getLibraryPaths(),
            ...this.toolchainManager.getLibraryPaths()
        ];

        // Log successful configuration
        this.outputChannel.appendLine('✅ Build configuration prepared successfully:');
        this.outputChannel.appendLine(`   📄 Project: ${path.basename(projectInfo.rootPath)}`);
        this.outputChannel.appendLine(`   🔧 Compiler: ${compilerPath}`);
        this.outputChannel.appendLine(`   📚 SDK: ${sdkPath}`);
        this.outputChannel.appendLine(`   📁 Include paths: ${includePaths.length} directories`);
        this.outputChannel.appendLine(`   📦 Library paths: ${libraryPaths.length} directories`);
        this.outputChannel.appendLine('');

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
                const platform = require('os').platform();
                
                // Ensure build directory exists
                if (!fs.existsSync(config.outputPath)) {
                    fs.mkdirSync(config.outputPath, { recursive: true });
                    this.outputChannel.appendLine(`📁 Created build directory: ${config.outputPath}`);
                }

                // Filter source files to only include ones that actually exist
                const validSourceFiles = await this.getValidSourceFiles(config);
                if (validSourceFiles.length === 0) {
                    throw new Error('No valid source files found for compilation');
                }

                this.outputChannel.appendLine(`📝 Compiling ${validSourceFiles.length} source files:`);
                validSourceFiles.forEach(file => {
                    this.outputChannel.appendLine(`   • ${path.relative(config.projectPath, file)}`);
                });

                // Build compiler arguments
                const args = this.buildCompilerArgs(config);
                
                // Add all source files
                validSourceFiles.forEach(sourceFile => {
                    args.push(sourceFile);
                });

                // Output file
                const outputFile = path.join(config.outputPath, 'main.out');
                args.push('-o');
                args.push(outputFile);

                // Add library paths (use -L, not -i)
                config.libraryPaths.forEach((libPath: string) => {
                    if (fs.existsSync(libPath)) {
                        args.push('-L');
                        args.push(libPath);
                    }
                });

                // Add linker script from syscfg if available
                const linkerScript = path.join(config.projectPath, 'syscfg', 'device_linker.cmd');
                if (fs.existsSync(linkerScript)) {
                    args.push('-Wl,-T');
                    args.push(linkerScript);
                    this.outputChannel.appendLine(`🔗 Using linker script: ${path.basename(linkerScript)}`);
                }

                // Additional linker flags
                args.push('-Wl,--gc-sections');         // Remove unused sections
                args.push('-Wl,--entry=Reset_Handler'); // Entry point

                // Display the full command being executed
                this.outputChannel.appendLine(`🔨 Executing: ${path.basename(config.compilerPath)} ${args.join(' ')}`);
                this.outputChannel.appendLine('');

                // Execute the compiler
                this.buildProcess = spawn(config.compilerPath, args, {
                    cwd: config.projectPath,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    // OS-specific options
                    ...(platform.startsWith('win32') ? {
                        windowsHide: true,
                        shell: false
                    } : {})
                });

                let stdout = '';
                let stderr = '';
                let hasCompileErrors = false;

                // Handle stdout
                this.buildProcess.stdout?.on('data', (data) => {
                    const output = data.toString();
                    stdout += output;
                    
                    const lines = output.split('\n');
                    lines.forEach((line: string) => {
                        if (line.trim()) {
                            this.outputChannel.appendLine(`  📝 ${line.trim()}`);
                        }
                    });
                });

                // Handle stderr (where most compiler output goes)
                this.buildProcess.stderr?.on('data', (data) => {
                    const output = data.toString();
                    stderr += output;
                    
                    const lines = output.split('\n');
                    lines.forEach((line: string) => {
                        if (line.trim()) {
                            if (line.toLowerCase().includes('error:')) {
                                hasCompileErrors = true;
                                this.outputChannel.appendLine(`  ❌ ${line.trim()}`);
                            } else if (line.toLowerCase().includes('warning:')) {
                                this.outputChannel.appendLine(`  ⚠️  ${line.trim()}`);
                            } else {
                                this.outputChannel.appendLine(`  📝 ${line.trim()}`);
                            }
                        }
                    });
                });

                // Handle process completion
                this.buildProcess.on('close', (code) => {
                    this.buildProcess = null;

                    this.outputChannel.appendLine('');
                    this.outputChannel.appendLine('📊 BUILD RESULTS');
                    this.outputChannel.appendLine('-'.repeat(30));

                    // Parse diagnostics from output
                    const diagnostics = this.parseBuildOutput(stdout + stderr, config.projectPath);
                    const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                    const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);

                    // Check if build was successful
                    const buildSuccess = code === 0 && !hasCompileErrors && errors.length === 0;
                    
                    const result: BuildResult = {
                        success: buildSuccess,
                        errors: errors,
                        warnings: warnings,
                        buildTime: Date.now() - this.buildStartTime,
                        outputPath: buildSuccess ? outputFile : undefined
                    };

                    if (result.success) {
                        this.outputChannel.appendLine(`✅ BUILD COMPLETED SUCCESSFULLY (Exit Code: ${code})`);
                        this.outputChannel.appendLine(`📦 Output: ${path.relative(config.projectPath, outputFile)}`);
                        
                        // Show file size if available
                        try {
                            const stats = fs.statSync(outputFile);
                            this.outputChannel.appendLine(`📏 Binary size: ${stats.size.toLocaleString()} bytes`);
                        } catch (e) {
                            // Size check failed but build was successful
                        }
                        
                        if (warnings.length > 0) {
                            this.outputChannel.appendLine(`⚠️  Note: ${warnings.length} warning(s) reported`);
                        }
                    } else {
                        this.outputChannel.appendLine(`❌ BUILD FAILED (Exit Code: ${code})`);
                        this.outputChannel.appendLine(`   • Errors: ${errors.length}`);
                        this.outputChannel.appendLine(`   • Warnings: ${warnings.length}`);
                        
                        // Show first few errors for quick reference
                        if (errors.length > 0) {
                            this.outputChannel.appendLine('');
                            this.outputChannel.appendLine('🚨 COMPILATION ERRORS:');
                            errors.slice(0, 3).forEach((error, index) => {
                                this.outputChannel.appendLine(`   ${index + 1}. ${error.message}`);
                            });
                            if (errors.length > 3) {
                                this.outputChannel.appendLine(`   ... and ${errors.length - 3} more errors`);
                            }
                        }
                    }

                    this.outputChannel.appendLine('');
                    this.outputChannel.appendLine('🚀 NEXT STEPS:');
                    if (result.success) {
                        this.outputChannel.appendLine('   • Use "Flash Firmware" to program your board');
                        this.outputChannel.appendLine('   • Use "Start Debug" to begin debugging session');
                    } else {
                        this.outputChannel.appendLine('   • Check the Problems panel for detailed error locations');
                        this.outputChannel.appendLine('   • Verify source files and include paths');
                        this.outputChannel.appendLine('   • Check compiler installation and permissions');
                    }
                    this.outputChannel.appendLine('='.repeat(80));

                    resolve(result);
                });

                // Handle process errors
                this.buildProcess.on('error', (error) => {
                    this.buildProcess = null;
                    this.outputChannel.appendLine(`❌ Build process error: ${error.message}`);
                    
                    // Platform-specific troubleshooting
                    if (platform.startsWith('win32')) {
                        this.outputChannel.appendLine('💡 Windows: Check compiler path and permissions');
                    } else {
                        this.outputChannel.appendLine('💡 Unix: Check executable permissions (chmod +x)');
                    }
                    
                    reject(new Error(`Build process error: ${error.message}`));
                });

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.outputChannel.appendLine(`❌ Build setup error: ${errorMessage}`);
                reject(error);
            }
        });
    }

    private async getValidSourceFiles(config: any): Promise<string[]> {
        const validFiles: string[] = [];
        
        // 1. Main source file
        const mainFile = path.join(config.projectPath, 'main.c');
        if (fs.existsSync(mainFile)) {
            validFiles.push(mainFile);
            this.outputChannel.appendLine(`✅ Found main source: main.c`);
        } else {
            this.outputChannel.appendLine(`❌ Missing main source: main.c`);
        }

        // 2. SysConfig generated file - ONLY from syscfg directory
        const syscfgFile = path.join(config.projectPath, 'syscfg', 'ti_msp_dl_config.c');
        if (fs.existsSync(syscfgFile)) {
            validFiles.push(syscfgFile);
            this.outputChannel.appendLine(`✅ Found SysConfig: syscfg/ti_msp_dl_config.c`);
        } else {
            this.outputChannel.appendLine(`⚠️  Missing SysConfig file: syscfg/ti_msp_dl_config.c`);
        }

        // 3. Startup file - look for ticlang version
        const possibleStartupFiles = [
            // In project directory
            path.join(config.projectPath, 'ticlang', 'startup_mspm0g350x_ticlang.c'),
            path.join(config.projectPath, 'startup_mspm0g350x_ticlang.c'),
            
            // In SDK
            path.join(this.sdkManager.getSDKPath(), 'source', 'ti', 'devices', 'msp', 'm0p', 'startup_system_files', 'ticlang', 'startup_mspm0g350x_ticlang.c')
        ];

        let startupFound = false;
        for (const startupFile of possibleStartupFiles) {
            if (fs.existsSync(startupFile)) {
                validFiles.push(startupFile);
                this.outputChannel.appendLine(`✅ Found startup: ${path.relative(config.projectPath, startupFile)}`);
                startupFound = true;
                break;
            }
        }
        
        if (!startupFound) {
            this.outputChannel.appendLine(`⚠️  No startup file found - build may fail at link stage`);
            this.outputChannel.appendLine(`   Searched: startup_mspm0g350x_ticlang.c`);
        }

        // 4. IMPORTANT: Skip compiler-specific duplicate files
        // Don't include ticlang/ti_msp_dl_config.c, gcc/ti_msp_dl_config.c, iar/ti_msp_dl_config.c
        // These are duplicates of the syscfg/ti_msp_dl_config.c file
        
        if (config.sourceFiles) {
            for (const sourceFile of config.sourceFiles) {
                if (fs.existsSync(sourceFile) && !validFiles.includes(sourceFile)) {
                    const fileName = path.basename(sourceFile).toLowerCase();
                    const relativePath = path.relative(config.projectPath, sourceFile);
                    
                    // Skip compiler-specific duplicate config files
                    if (relativePath.includes('ticlang') && fileName === 'ti_msp_dl_config.c') {
                        this.outputChannel.appendLine(`⏭️  Skipping duplicate: ${relativePath} (using syscfg version instead)`);
                        continue;
                    }
                    if (relativePath.includes('gcc') && fileName === 'ti_msp_dl_config.c') {
                        this.outputChannel.appendLine(`⏭️  Skipping duplicate: ${relativePath} (using syscfg version instead)`);
                        continue;
                    }
                    if (relativePath.includes('iar') && fileName === 'ti_msp_dl_config.c') {
                        this.outputChannel.appendLine(`⏭️  Skipping duplicate: ${relativePath} (using syscfg version instead)`);
                        continue;
                    }
                    
                    // Skip other compiler-specific files we don't want
                    if (fileName.includes('iar') || fileName.includes('gcc') || 
                        (fileName.includes('startup') && !fileName.includes('ticlang'))) {
                        this.outputChannel.appendLine(`⏭️  Skipping non-ticlang file: ${relativePath}`);
                        continue;
                    }
                    
                    // Include valid C files
                    if (fileName.endsWith('.c')) {
                        validFiles.push(sourceFile);
                        this.outputChannel.appendLine(`✅ Additional source: ${relativePath}`);
                    }
                }
            }
        }

        this.outputChannel.appendLine(`📊 Total valid source files: ${validFiles.length}`);
        
        // Verify we have essential files
        const hasMain = validFiles.some(f => path.basename(f) === 'main.c');
        const hasSysConfig = validFiles.some(f => f.includes('syscfg') && f.endsWith('ti_msp_dl_config.c'));
        const hasStartup = validFiles.some(f => f.includes('startup_mspm0g350x_ticlang.c'));
        
        this.outputChannel.appendLine(`📋 Essential files check:`);
        this.outputChannel.appendLine(`   • main.c: ${hasMain ? '✅' : '❌'}`);
        this.outputChannel.appendLine(`   • SysConfig: ${hasSysConfig ? '✅' : '❌'}`);
        this.outputChannel.appendLine(`   • Startup: ${hasStartup ? '✅' : '❌'}`);
        
        if (!hasMain) {
            throw new Error('main.c is required but not found');
        }
        if (!hasSysConfig) {
            this.outputChannel.appendLine(`⚠️  Warning: No SysConfig file found - build may fail`);
        }
        if (!hasStartup) {
            this.outputChannel.appendLine(`⚠️  Warning: No startup file found - linking may fail`);
        }
        
        return validFiles;
    }

    private async runSysConfigGeneration(): Promise<void> {
        // Find .syscfg files in the project
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.outputChannel.appendLine('No workspace folder available for SysConfig generation');
            return;
        }

        const sysConfigFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceFolders[0], '**/*.syscfg'),
            null,
            10
        );

        if (sysConfigFiles.length === 0) {
            this.outputChannel.appendLine('No .syscfg files found, skipping SysConfig generation');
            return;
        }

        const sysConfigCliPath = this.sysConfigManager.getSysConfigCliPath();
        const sdkPath = this.sdkManager.getSDKPath();
        
        // Check if product.json exists
        const productJsonPath = path.join(sdkPath, '.metadata', 'product.json');
        if (!fs.existsSync(productJsonPath)) {
            throw new Error(`Product.json not found at: ${productJsonPath}. Please ensure MSPM0 SDK is properly installed.`);
        }

        for (const sysConfigFile of sysConfigFiles) {
            const sysConfigFilePath = sysConfigFile.fsPath;
            const fileName = path.basename(sysConfigFilePath);
            const projectDir = path.dirname(sysConfigFilePath);
            
            this.outputChannel.appendLine(`🔧 Processing SysConfig file: ${fileName}`);
            
            // Create syscfg output directory if it doesn't exist
            const syscfgOutputDir = path.join(projectDir, 'syscfg');
            if (!fs.existsSync(syscfgOutputDir)) {
                fs.mkdirSync(syscfgOutputDir, { recursive: true });
                this.outputChannel.appendLine(`   Created output directory: ${syscfgOutputDir}`);
            }

            // Correct SysConfig CLI arguments based on your Compiler_Commands.txt example:
            // /opt/ti/sysconfig_1.20.0/sysconfig_cli.sh --script ../main.syscfg -o "syscfg" -s /home/mspm0-sdk/.metadata/product.json --compiler ticlang
            const args = [
                '--script', sysConfigFilePath,           // The .syscfg file to process
                '-o', 'syscfg',                          // Output directory (relative to working directory)
                '-s', productJsonPath,                   // SDK product.json file  
                '--compiler', 'ticlang'                  // Compiler type (NOT 'ccs')
            ];

            this.outputChannel.appendLine(`   Arguments: ${args.join(' ')}`);

            await this.runSysConfigCLI(sysConfigCliPath, args, projectDir);
        }
    }

    private async runSysConfigCLI(sysConfigCliPath: string, args: string[], cwd: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const platform = require('os').platform();
            let sysConfigProcess: ChildProcess;

            // Clean the path - remove extra quotes if present
            const cleanPath = sysConfigCliPath.replace(/^"(.*)"$/, '$1');
            
            this.outputChannel.appendLine(`🔧 Executing SysConfig CLI:`);
            this.outputChannel.appendLine(`   Path: ${cleanPath}`);
            this.outputChannel.appendLine(`   Args: ${args.join(' ')}`);
            this.outputChannel.appendLine(`   Working directory: ${cwd}`);

            if (platform.startsWith('win32') && cleanPath.endsWith('.bat')) {
                // Windows batch file - don't add extra quotes around the path
                sysConfigProcess = spawn('cmd', ['/c', cleanPath, ...args], {
                    cwd: cwd,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                    shell: false  // Prevent shell interpretation issues
                });
            } else {
                // Direct execution for other platforms
                sysConfigProcess = spawn(cleanPath, args, {
                    cwd: cwd,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            }

            let hasRealError = false;
            let errorOutput = '';
            let warningCount = 0;
            let errorCount = 0;

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
                errorOutput += output;
                const lines = output.split('\n');
                lines.forEach((line: string) => {
                    if (line.trim()) {
                        const trimmedLine = line.trim();
                        
                        // Parse the summary line: "❌ 0 error(s), 9 warning(s)"
                        const summaryMatch = trimmedLine.match(/^❌?\s*(\d+)\s+error\(s\),\s*(\d+)\s+warning\(s\)$/);
                        if (summaryMatch) {
                            errorCount = parseInt(summaryMatch[1]);
                            warningCount = parseInt(summaryMatch[2]);
                            
                            if (errorCount > 0) {
                                hasRealError = true;
                                this.outputChannel.appendLine(`  ❌ SysConfig Summary: ${errorCount} error(s), ${warningCount} warning(s)`);
                            } else {
                                this.outputChannel.appendLine(`  ⚠️  SysConfig Summary: ${errorCount} error(s), ${warningCount} warning(s)`);
                            }
                            return;
                        }
                        
                        // Check for actual error indicators (but not the summary line)
                        if ((trimmedLine.toLowerCase().includes('error') && 
                            !trimmedLine.match(/\d+\s+error\(s\)/)) ||  // Not a summary line
                            trimmedLine.toLowerCase().includes('invalid') ||
                            trimmedLine.toLowerCase().includes('not recognized') ||
                            trimmedLine.toLowerCase().includes('not found') ||
                            trimmedLine.toLowerCase().includes('failed')) {
                            hasRealError = true;
                            this.outputChannel.appendLine(`  ❌ ${trimmedLine}`);
                        } else if (trimmedLine.toLowerCase().includes('usage:') || 
                                trimmedLine.toLowerCase().includes('example:') ||
                                trimmedLine.toLowerCase().includes('note that')) {
                            // This is help text, not an error
                            this.outputChannel.appendLine(`  ℹ️  ${trimmedLine}`);
                        } else if (trimmedLine.toLowerCase().includes('warning:')) {
                            // Regular warning message
                            this.outputChannel.appendLine(`  ⚠️  ${trimmedLine}`);
                        } else {
                            // Other informational messages
                            this.outputChannel.appendLine(`  🔧 ${trimmedLine}`);
                        }
                    }
                });
            });

            sysConfigProcess.on('close', (code) => {
                this.outputChannel.appendLine(`SysConfig process closed with code: ${code}`);
                
                // Success criteria: exit code 0 AND no real errors (warnings are OK)
                if (code === 0 && !hasRealError) {
                    this.outputChannel.appendLine('  ✅ SysConfig code generation completed successfully');
                    
                    if (warningCount > 0) {
                        this.outputChannel.appendLine(`  ⚠️  Note: ${warningCount} warning(s) were reported but do not prevent compilation`);
                    }
                    
                    // Verify that files were actually generated
                    const expectedFiles = ['ti_msp_dl_config.c', 'ti_msp_dl_config.h'];
                    const syscfgDir = path.join(cwd, 'syscfg');
                    let generatedCount = 0;
                    
                    for (const expectedFile of expectedFiles) {
                        const filePath = path.join(syscfgDir, expectedFile);
                        if (fs.existsSync(filePath)) {
                            generatedCount++;
                            this.outputChannel.appendLine(`    ✅ Generated: ${expectedFile}`);
                        } else {
                            this.outputChannel.appendLine(`    ⚠️  Missing: ${expectedFile}`);
                        }
                    }
                    
                    if (generatedCount === expectedFiles.length) {
                        this.outputChannel.appendLine(`  🎉 SysConfig generation successful - all required files created`);
                        if (warningCount > 0) {
                            this.outputChannel.appendLine(`  📝 Summary: 0 errors, ${warningCount} warnings (warnings are non-blocking)`);
                        }
                        this.outputChannel.appendLine('');
                        resolve();
                    } else if (generatedCount > 0) {
                        this.outputChannel.appendLine(`  ✅ SysConfig generation partial success (${generatedCount}/${expectedFiles.length} files created)`);
                        this.outputChannel.appendLine('  ⚠️  Some files missing but continuing build...');
                        this.outputChannel.appendLine('');
                        resolve(); // Continue anyway if we have some files
                    } else {
                        const errorMsg = 'SysConfig completed but no output files were generated';
                        this.outputChannel.appendLine(`  ❌ ${errorMsg}`);
                        this.outputChannel.appendLine('');
                        reject(new Error(errorMsg));
                    }
                } else if (code !== 0) {
                    const errorMsg = `SysConfig generation failed with exit code ${code}`;
                    this.outputChannel.appendLine(`  ❌ ${errorMsg}`);
                    this.outputChannel.appendLine('');
                    this.provideSysConfigTroubleshooting();
                    reject(new Error(errorMsg));
                } else if (hasRealError && errorCount > 0) {
                    const errorMsg = `SysConfig generation failed with ${errorCount} error(s)`;
                    this.outputChannel.appendLine(`  ❌ ${errorMsg}`);
                    this.outputChannel.appendLine('');
                    this.provideSysConfigTroubleshooting();
                    reject(new Error(errorMsg));
                }
            });

            sysConfigProcess.on('error', (error) => {
                hasRealError = true;
                const errorMsg = `SysConfig process error: ${error.message}`;
                this.outputChannel.appendLine(`  ❌ ${errorMsg}`);
                reject(new Error(errorMsg));
            });

            // Timeout after 60 seconds (increased because SysConfig can be slow)
            setTimeout(() => {
                if (sysConfigProcess && !sysConfigProcess.killed) {
                    sysConfigProcess.kill();
                    reject(new Error('SysConfig generation timed out after 60 seconds'));
                }
            }, 60000);
        });
    }

    private provideSysConfigTroubleshooting(): void {
        this.outputChannel.appendLine('🔍 SysConfig Troubleshooting:');
        this.outputChannel.appendLine('   1. Open the .syscfg file in TI SysConfig GUI to resolve configuration issues');
        this.outputChannel.appendLine('   2. Check device/board settings in the .syscfg file');
        this.outputChannel.appendLine('   3. Verify pin assignments don\'t conflict with board constraints');
        this.outputChannel.appendLine('   4. Update .syscfg file if migrating from older SysConfig version');
        this.outputChannel.appendLine('   5. Check that all required peripherals are properly configured');
        this.outputChannel.appendLine('');
    }

    private buildCompilerArgs(config: any): string[] {
        const args: string[] = [];
        const platform = require('os').platform();
        
        // ARM Cortex-M0+ specific flags (LLVM syntax, not TI CCS syntax)
        args.push('-march=thumbv6m');           // Target architecture
        args.push('-mcpu=cortex-m0plus');       // CPU target  
        args.push('-mfloat-abi=soft');          // Software floating point
        args.push('-mlittle-endian');           // Little endian byte order
        args.push('-mthumb');                   // Thumb instruction set

        // Optimization and debug settings
        if (config.optimization === 'debug') {
            args.push('-O0');                   // No optimization
            args.push('-g');                    // Debug information
            args.push('-gdwarf-3');             // DWARF-3 debug format
        } else {
            args.push('-O2');                   // Optimize for speed
        }

        // Include paths (use -I, not -i) - ADD CMSIS FIRST
        const sdkPath = this.sdkManager.getSDKPath();
        
        // CRITICAL: Add CMSIS Core include path FIRST
        const cmsisCorePath = path.join(sdkPath, 'source', 'third_party', 'CMSIS', 'Core', 'Include');
        if (fs.existsSync(cmsisCorePath)) {
            args.push('-I');
            args.push(cmsisCorePath);
            this.outputChannel.appendLine(`✅ Added CMSIS Core include: ${cmsisCorePath}`);
        } else {
            this.outputChannel.appendLine(`❌ CMSIS Core not found: ${cmsisCorePath}`);
        }

        // Add other SDK include paths
        config.includePaths.forEach((includePath: string) => {
            args.push('-I');
            args.push(includePath);
        });

        // Add syscfg include directory
        const syscfgIncludePath = path.join(config.projectPath, 'syscfg');
        if (fs.existsSync(syscfgIncludePath)) {
            args.push('-I');
            args.push(syscfgIncludePath);
        }

        // Target device define
        args.push('-D__MSPM0G3507__');
        
        // Additional useful defines
        args.push('-DTARGET_IS_MSPM0G3507');

        // OS-specific compiler flags
        if (platform.startsWith('win32')) {
            args.push('-fdiagnostics-format=msvc');  // Use MSVC-style error format for VS Code integration
            args.push('-D_WIN32');
        } else if (platform.startsWith('darwin')) {
            args.push('-fdiagnostics-format=clang'); // Use Clang error format
            args.push('-D__APPLE__');
        } else {
            args.push('-fdiagnostics-format=clang'); // Use Clang error format
            args.push('-D__linux__');
        }

        // Compiler flags for better compilation
        args.push('-MMD');                      // Generate dependency files
        args.push('-MP');                       // Add phony targets
        args.push('-Wall');                     // Enable warnings
        args.push('-Wextra');                   // Extra warnings
        args.push('-Wno-unused-parameter');     // Don't warn about unused params
        args.push('-Wno-sign-compare');         // Don't warn about signed/unsigned comparisons
        args.push('-std=c99');                  // C99 standard

        this.outputChannel.appendLine(`🔧 Generated ${args.length} compiler arguments for ${platform}`);
        
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