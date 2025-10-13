import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface SourceLineAddress {
    file: string;
    line: number;
    address: string;
    functionName?: string;
}

/**
 * Maps source code lines to their memory addresses using disassembly output
 */
export class AddressMapper {
    private lineToAddressMap: Map<string, string> = new Map();
    private addressToLineMap: Map<string, { file: string; line: number; functionName?: string }> = new Map();
    private functionToAddressMap: Map<string, string> = new Map();
    private disassemblyPath: string | null = null;

    /**
     * Load and parse disassembly file to build address mapping
     */
    public async loadDisassembly(workspaceRoot: string): Promise<boolean> {
        // Try to find disassembly file
        const disasmPath = path.join(workspaceRoot, 'full_disasm.txt');

        if (!fs.existsSync(disasmPath)) {
            console.log('Disassembly file not found:', disasmPath);
            return false;
        }

        this.disassemblyPath = disasmPath;

        try {
            const content = fs.readFileSync(disasmPath, 'utf-8');
            this.parseDisassembly(content);
            return true;
        } catch (error) {
            console.error('Error loading disassembly:', error);
            return false;
        }
    }

    /**
     * Parse disassembly content and build line-to-address mapping
     */
    private parseDisassembly(content: string): void {
        const lines = content.split('\n');
        let currentFile: string | null = null;
        let currentFunction: string | null = null;

        // First pass: build function name to address map
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Match function symbols: 00000260 <DL_GPIO_togglePins>:
            const funcMatch = line.match(/^([0-9a-fA-F]{8})\s+<([^>]+)>:/);
            if (funcMatch) {
                const address = '0x' + funcMatch[1];
                const functionName = funcMatch[2];
                this.functionToAddressMap.set(functionName, address);
            }
        }

        // Second pass: build line to address map (and reverse map)
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Match file path comments: ; /path/to/file.c:123
            const fileMatch = line.match(/^;\s*([^:]+):(\d+)/);
            if (fileMatch) {
                currentFile = fileMatch[1];
                const lineNumber = parseInt(fileMatch[2]);

                // Look ahead for the next instruction address
                const address = this.findNextInstructionAddress(lines, i);
                if (address && currentFile) {
                    const key = this.makeKey(currentFile, lineNumber);
                    this.lineToAddressMap.set(key, address);

                    // Build reverse map: address -> source location
                    const normalizedAddress = address.toLowerCase();
                    this.addressToLineMap.set(normalizedAddress, {
                        file: currentFile,
                        line: lineNumber,
                        functionName: currentFunction || undefined
                    });
                }
                continue;
            }

            // Match function symbols: 00000148 <main>:
            const funcMatch = line.match(/^([0-9a-fA-F]{8})\s+<(\w+)>:/);
            if (funcMatch) {
                const address = '0x' + funcMatch[1];
                currentFunction = funcMatch[2];

                // Store function entry point
                if (currentFunction) {
                    const key = `func:${currentFunction}`;
                    this.lineToAddressMap.set(key, address);
                }
            }
        }
    }

    /**
     * Find the next instruction address after a source line comment
     * Returns the instruction address (NOT the target of bl/blx)
     */
    private findNextInstructionAddress(lines: string[], startIndex: number): string | null {
        for (let i = startIndex + 1; i < Math.min(startIndex + 10, lines.length); i++) {
            const line = lines[i];

            // Stop if we encounter another source line comment
            if (line.match(/^;\s*([^:]+):(\d+)/)) {
                break;
            }

            // Match instruction lines: "     132: f000 f89f    bl    0x274 <DL_GPIO_setPins> @ imm = #0x13e"
            const instrMatch = line.match(/^\s+([0-9a-fA-F]+):\s+[0-9a-fA-F]/);
            if (instrMatch) {
                const instructionAddress = '0x' + instrMatch[1];

                // Check if this is a branch/call instruction (bl or blx)
                const branchMatch = line.match(/\b(bl|blx)\s+0x([0-9a-fA-F]+)/);
                if (branchMatch) {
                    // Return the INSTRUCTION address (where the bl is), not the target
                    // This is what PC points to when halted at a call
                    return instructionAddress;
                }

                // For non-branch instructions, return the instruction address
                return instructionAddress;
            }
        }

        return null;
    }

    /**
     * Get memory address for a source file line
     */
    public getAddressForLine(file: string, line: number): string | null {
        // Normalize the file path to use forward slashes (works on all platforms)
        const normalizedFile = file.replace(/\\/g, '/');
        const key = this.makeKey(normalizedFile, line);
        return this.lineToAddressMap.get(key) || null;
    }

    /**
     * Get memory address for a function by name
     */
    public getAddressForFunction(functionName: string): string | null {
        const key = `func:${functionName}`;
        return this.lineToAddressMap.get(key) || null;
    }

    /**
     * Get source location for a memory address (reverse lookup)
     */
    public getSourceLocationForAddress(address: string): { file: string; line: number; functionName?: string } | null {
        // Normalize address: remove 0x prefix, convert to lowercase, remove leading zeros
        const cleanAddress = address.replace(/^0x/i, '').toLowerCase();

        // Remove leading zeros but keep at least one digit
        const trimmedAddress = cleanAddress.replace(/^0+/, '') || '0';

        // Try multiple formats:
        // 1. With 0x prefix and trimmed (0x300)
        const format1 = '0x' + trimmedAddress;
        let result = this.addressToLineMap.get(format1);
        if (result) {
            return result;
        }

        // 2. Without prefix, trimmed (300)
        result = this.addressToLineMap.get(trimmedAddress);
        if (result) {
            return result;
        }

        // 3. With prefix and leading zeros (0x00000300)
        const format3 = '0x' + cleanAddress;
        result = this.addressToLineMap.get(format3);
        if (result) {
            return result;
        }

        // 4. Without prefix, with leading zeros (00000300)
        result = this.addressToLineMap.get(cleanAddress);
        if (result) {
            return result;
        }

        return null;
    }

    /**
     * Get all breakpoint addresses from VS Code breakpoints
     */
    public getBreakpointAddresses(): SourceLineAddress[] {
        const breakpoints = vscode.debug.breakpoints;
        const result: SourceLineAddress[] = [];

        breakpoints.forEach(bp => {
            if (bp instanceof vscode.SourceBreakpoint) {
                const location = bp.location;
                const filePath = location.uri.fsPath;
                const lineNumber = location.range.start.line + 1; // Convert to 1-based

                // FIX: Normalize the file path before looking up address
                // This ensures Windows paths (C:\path\file.c) match the normalized keys
                const normalizedPath = filePath.replace(/\\/g, '/');

                const address = this.getAddressForLine(normalizedPath, lineNumber);

                if (address) {
                    result.push({
                        file: vscode.workspace.asRelativePath(location.uri),
                        line: lineNumber,
                        address: address
                    });
                }
            } else if (bp instanceof vscode.FunctionBreakpoint) {
                const address = this.getAddressForFunction(bp.functionName);

                if (address) {
                    result.push({
                        file: bp.functionName,
                        line: 0,
                        address: address,
                        functionName: bp.functionName
                    });
                }
            }
        });

        return result;
    }

    /**
     * Create a unique key for file:line mapping
     */
    private makeKey(file: string, line: number): string {
        // Normalize file path to handle different formats
        const normalizedFile = file.replace(/\\/g, '/');
        return `${normalizedFile}:${line}`;
    }

    /**
     * Check if disassembly is loaded
     */
    public isLoaded(): boolean {
        return this.disassemblyPath !== null && this.lineToAddressMap.size > 0;
    }

    /**
     * Get statistics about loaded addresses
     */
    public getStats(): { totalMappings: number; disassemblyPath: string | null } {
        return {
            totalMappings: this.lineToAddressMap.size,
            disassemblyPath: this.disassemblyPath
        };
    }

    /**
     * Debug: Get a sample of addresses from the reverse map
     */
    public getSampleAddresses(limit: number = 10): string[] {
        const addresses: string[] = [];
        let count = 0;
        for (const [addr] of this.addressToLineMap) {
            addresses.push(addr);
            count++;
            if (count >= limit) break;
        }
        return addresses;
    }
}
