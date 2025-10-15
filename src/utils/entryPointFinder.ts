import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Result of entry point detection
 */
export interface EntryPointResult {
    /** Absolute path to the entry point file */
    filePath: string;
    /** Filename (e.g., "main.c" or "app.c") */
    fileName: string;
    /** Base name without extension (e.g., "main" or "app") */
    baseName: string;
}

/**
 * Finds files containing the main() function in the workspace.
 * Searches for C/C++ files with a main() entry point function.
 *
 * @param workspacePath - The workspace root path to search in
 * @param outputChannel - Optional output channel for logging
 * @returns Array of entry point file paths found
 */
export async function findEntryPointFiles(
    workspacePath: string,
    outputChannel?: vscode.OutputChannel
): Promise<string[]> {
    const entryPoints: string[] = [];

    try {
        outputChannel?.appendLine('Searching for entry point files with main() function...');

        // Search for all .c and .cpp files in the workspace
        const sourceFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspacePath, '**/*.{c,cpp}'),
            '**/build/**', // Exclude build directory
            100
        );

        outputChannel?.appendLine(`   Found ${sourceFiles.length} source files to check`);

        // Regex pattern to match main() function declarations
        // Matches: int main(void), void main(void), main(void), int main(), etc.
        const mainFunctionPattern = /^\s*(int|void)?\s*main\s*\(\s*(void)?\s*\)\s*\{?/m;

        for (const file of sourceFiles) {
            const filePath = file.fsPath;

            try {
                // Read file content
                const content = fs.readFileSync(filePath, 'utf8');

                // Check if file contains main() function
                if (mainFunctionPattern.test(content)) {
                    entryPoints.push(filePath);
                    outputChannel?.appendLine(`   ✓ Found entry point: ${path.basename(filePath)}`);
                }
            } catch (error) {
                outputChannel?.appendLine(`   Warning: Could not read file ${path.basename(filePath)}: ${error}`);
            }
        }

        outputChannel?.appendLine(`Entry point search complete: found ${entryPoints.length} file(s)`);

    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`Error searching for entry points: ${errorMsg}`);
        throw new Error(`Failed to find entry point files: ${errorMsg}`);
    }

    return entryPoints;
}

/**
 * Detects the entry point file for the project.
 * If multiple entry points are found, prompts the user to select one.
 *
 * @param workspacePath - The workspace root path
 * @param outputChannel - Optional output channel for logging
 * @returns Entry point result or undefined if cancelled/not found
 */
export async function detectEntryPoint(
    workspacePath: string,
    outputChannel?: vscode.OutputChannel
): Promise<EntryPointResult | undefined> {

    // Find all entry point files
    const entryPoints = await findEntryPointFiles(workspacePath, outputChannel);

    if (entryPoints.length === 0) {
        outputChannel?.appendLine('ERROR: No entry point file found with main() function');
        throw new Error(
            'No entry point found. Please ensure you have a .c or .cpp file with a main() function.'
        );
    }

    let selectedFile: string;

    if (entryPoints.length === 1) {
        // Only one entry point found - use it
        selectedFile = entryPoints[0];
        outputChannel?.appendLine(`Using entry point: ${path.basename(selectedFile)}`);
    } else {
        // Multiple entry points found - ask user to select
        outputChannel?.appendLine(`Multiple entry points found: ${entryPoints.length}`);

        const items = entryPoints.map(file => ({
            label: path.basename(file),
            description: path.relative(workspacePath, path.dirname(file)),
            detail: file,
            filePath: file
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Multiple entry points found. Select the main entry point for your project:',
            title: 'Select Entry Point File',
            ignoreFocusOut: true
        });

        if (!selected) {
            outputChannel?.appendLine('Entry point selection cancelled by user');
            throw new Error('Entry point selection cancelled');
        }

        selectedFile = selected.filePath;
        outputChannel?.appendLine(`User selected entry point: ${path.basename(selectedFile)}`);
    }

    // Create result object
    const fileName = path.basename(selectedFile);
    const baseName = path.basename(selectedFile, path.extname(selectedFile));

    return {
        filePath: selectedFile,
        fileName: fileName,
        baseName: baseName
    };
}
