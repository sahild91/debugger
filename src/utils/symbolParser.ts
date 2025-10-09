import * as fs from 'fs';
import * as path from 'path';
import { VariableInfo } from '../types/variable';

/**
 * Parse disassembly output from tiarmobjdump to extract variable information
 * Expected format from: tiarmobjdump -lS main.out
 */
export class SymbolParser {
    /**
     * Parse disassembly file for variable symbols
     * Looks for patterns like:
     * - Variable declarations in source comments
     * - Symbol table entries
     * - Memory addresses with variable names
     */
    static parseDisassemblyFile(filePath: string): VariableInfo[] {
        const variables: VariableInfo[] = [];

        if (!fs.existsSync(filePath)) {
            return variables;
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Look for variable declarations in source code comments
            // Format: "int count = 0;" or similar
            const varDeclMatch = line.match(/^\s*(?:int|uint|char|long|short|float|double|void\*?)\s+(\w+)\s*[=;]/);
            if (varDeclMatch) {
                const varName = varDeclMatch[1];

                // Try to find the address in nearby lines
                const address = this.findNearbyAddress(lines, i);

                if (address) {
                    variables.push({
                        name: varName,
                        address: address,
                        scope: this.inferScope(varName, line),
                        filePath: this.extractFilePath(lines, i),
                        line: this.extractLineNumber(lines, i)
                    });
                }
            }

            // Look for symbol table style entries
            // Format: "20000000 <variable_name>:"
            const symbolMatch = line.match(/^([0-9a-fA-F]{8})\s+<(\w+)>:/);
            if (symbolMatch) {
                const address = '0x' + symbolMatch[1];
                const symbolName = symbolMatch[2];

                // Filter out function symbols (usually have capital first letter or _start, etc)
                if (!this.isFunctionSymbol(symbolName)) {
                    variables.push({
                        name: symbolName,
                        address: this.normalizeAddress(address),
                        scope: this.inferScopeFromSymbol(symbolName)
                    });
                }
            }

            // Look for .data or .bss section variables
            // Format: "20000004:	deadbeef 	.word	0xdeadbeef  ; variable_name"
            const dataMatch = line.match(/^([0-9a-fA-F]{8}):\s+[0-9a-fA-F]+\s+\.word\s+.*;\s*(\w+)/);
            if (dataMatch) {
                const address = '0x' + dataMatch[1];
                const varName = dataMatch[2];

                variables.push({
                    name: varName,
                    address: this.normalizeAddress(address),
                    scope: 'global',
                    type: 'word'
                });
            }
        }

        return this.deduplicateVariables(variables);
    }

    private static findNearbyAddress(lines: string[], startIndex: number): string | undefined {
        // Look in the next 5 lines for a memory address
        for (let i = startIndex; i < Math.min(startIndex + 5, lines.length); i++) {
            const addrMatch = lines[i].match(/\b([0-9a-fA-F]{8})\b/);
            if (addrMatch) {
                return '0x' + addrMatch[1];
            }
        }
        return undefined;
    }

    private static extractFilePath(lines: string[], index: number): string | undefined {
        // Look backwards for file path comment
        for (let i = index; i >= Math.max(0, index - 10); i--) {
            const fileMatch = lines[i].match(/^\s*\/\*\s*([^:]+):(\d+)/);
            if (fileMatch) {
                return fileMatch[1];
            }
        }
        return undefined;
    }

    private static extractLineNumber(lines: string[], index: number): number | undefined {
        // Look backwards for line number comment
        for (let i = index; i >= Math.max(0, index - 10); i--) {
            const lineMatch = lines[i].match(/^\s*\/\*\s*[^:]+:(\d+)/);
            if (lineMatch) {
                return parseInt(lineMatch[1]);
            }
        }
        return undefined;
    }

    private static inferScope(varName: string, line: string): 'local' | 'global' | 'static' {
        if (line.includes('static')) {
            return 'static';
        }
        // Variables starting with g_ or global_ are likely global
        if (varName.startsWith('g_') || varName.startsWith('global_')) {
            return 'global';
        }
        return 'local';
    }

    private static inferScopeFromSymbol(symbolName: string): 'local' | 'global' | 'static' {
        if (symbolName.startsWith('g_') || symbolName.startsWith('global_')) {
            return 'global';
        }
        if (symbolName.startsWith('s_') || symbolName.startsWith('static_')) {
            return 'static';
        }
        return 'local';
    }

    private static isFunctionSymbol(symbolName: string): boolean {
        // Heuristics to identify function symbols
        const functionPatterns = [
            /^[A-Z]/, // Starts with capital letter
            /^_start$/,
            /^main$/,
            /^__.*__$/, // System symbols
            /Handler$/, // Interrupt handlers
            /Callback$/,
        ];

        return functionPatterns.some(pattern => pattern.test(symbolName));
    }

    private static normalizeAddress(address: string): string {
        const cleanAddr = address.replace(/^0x/i, '').toUpperCase();
        const noLeadingZeros = cleanAddr.replace(/^0+/, '') || '0';
        return '0x' + noLeadingZeros;
    }

    private static deduplicateVariables(variables: VariableInfo[]): VariableInfo[] {
        const seen = new Map<string, VariableInfo>();

        for (const variable of variables) {
            const key = `${variable.name}_${variable.address}`;
            if (!seen.has(key)) {
                seen.set(key, variable);
            }
        }

        return Array.from(seen.values());
    }

    /**
     * Find the .out file in build directory
     */
    static findElfFile(workspaceRoot: string): string | null {
        const buildDirs = ['build', 'out', 'bin', 'Debug', 'Release'];

        for (const dir of buildDirs) {
            const buildPath = path.join(workspaceRoot, dir);
            if (fs.existsSync(buildPath)) {
                const files = fs.readdirSync(buildPath);
                const elfFile = files.find(f => f.endsWith('.out') || f.endsWith('.elf'));
                if (elfFile) {
                    return path.join(buildPath, elfFile);
                }
            }
        }

        return null;
    }

    /**
     * Parse ELF file directly to extract variable symbols
     * This reads the symbol table from the ELF file using basic binary parsing
     */
    static parseElfSymbols(elfPath: string): VariableInfo[] {
        const variables: VariableInfo[] = [];

        try {
            if (!fs.existsSync(elfPath)) {
                return variables;
            }

            // Read the entire ELF file
            const buffer = fs.readFileSync(elfPath);

            // Verify ELF magic number (0x7F 'E' 'L' 'F')
            if (buffer.length < 4 || buffer[0] !== 0x7F || buffer[1] !== 0x45 || buffer[2] !== 0x4C || buffer[3] !== 0x46) {
                console.error('Not a valid ELF file');
                return variables;
            }

            // Read ELF class (32-bit or 64-bit)
            const elfClass = buffer[4]; // 1 = 32-bit, 2 = 64-bit
            const is32Bit = elfClass === 1;

            // Read endianness (5th byte: 1 = little-endian, 2 = big-endian)
            const isLittleEndian = buffer[5] === 1;

            // For ARM Cortex-M (32-bit little-endian)
            if (!is32Bit || !isLittleEndian) {
                console.error('Only 32-bit little-endian ELF files are supported');
                return variables;
            }

            // Read section header table offset and entry size
            const shoff = buffer.readUInt32LE(0x20); // Section header table offset
            const shentsize = buffer.readUInt16LE(0x2E); // Section header entry size
            const shnum = buffer.readUInt16LE(0x30); // Number of section headers
            const shstrndx = buffer.readUInt16LE(0x32); // Section header string table index

            // Find .symtab (symbol table) and .strtab (string table) sections
            let symtabOffset = 0;
            let symtabSize = 0;
            let symtabEntsize = 0;
            let strtabOffset = 0;

            // Read section header string table first
            const shstrtabHeaderOffset = shoff + (shstrndx * shentsize);
            const shstrtabOffset = buffer.readUInt32LE(shstrtabHeaderOffset + 0x10);

            // Read section headers to find .symtab and .strtab
            for (let i = 0; i < shnum; i++) {
                const sectionHeaderOffset = shoff + (i * shentsize);
                const nameIdx = buffer.readUInt32LE(sectionHeaderOffset);
                const type = buffer.readUInt32LE(sectionHeaderOffset + 0x04);
                const offset = buffer.readUInt32LE(sectionHeaderOffset + 0x10);
                const size = buffer.readUInt32LE(sectionHeaderOffset + 0x14);
                const link = buffer.readUInt32LE(sectionHeaderOffset + 0x18);
                const entsize = buffer.readUInt32LE(sectionHeaderOffset + 0x24);

                // Get section name from section header string table
                const sectionName = this.readNullTerminatedString(buffer, shstrtabOffset + nameIdx);

                if (sectionName === '.symtab' && type === 2) { // SHT_SYMTAB
                    symtabOffset = offset;
                    symtabSize = size;
                    symtabEntsize = entsize;
                    // The linked section is the string table
                    const strtabHeaderOffset = shoff + (link * shentsize);
                    strtabOffset = buffer.readUInt32LE(strtabHeaderOffset + 0x10);
                }
            }

            if (symtabOffset === 0 || strtabOffset === 0) {
                console.error('Symbol table or string table not found in ELF file');
                return variables;
            }

            // Parse symbol table entries
            const numSymbols = symtabSize / symtabEntsize;
            for (let i = 0; i < numSymbols; i++) {
                const symbolOffset = symtabOffset + (i * symtabEntsize);

                const nameIdx = buffer.readUInt32LE(symbolOffset);
                const value = buffer.readUInt32LE(symbolOffset + 0x04);
                const size = buffer.readUInt32LE(symbolOffset + 0x08);
                const info = buffer.readUInt8(symbolOffset + 0x0C);
                const shndx = buffer.readUInt16LE(symbolOffset + 0x0E);

                // Extract symbol type and binding
                const type = info & 0x0F;
                const bind = info >> 4;

                // We're interested in OBJECT types (variables) and FUNC types (functions)
                // Type 1 = STT_OBJECT (data object), Type 2 = STT_FUNC (function)
                // For debugging purposes, show both variables and functions
                if (type !== 1 && type !== 2) {
                    continue; // Skip other symbol types
                }

                // Skip undefined symbols (shndx = 0)
                if (shndx === 0 || value === 0) {
                    continue;
                }

                // Read symbol name from string table
                const symbolName = this.readNullTerminatedString(buffer, strtabOffset + nameIdx);

                if (!symbolName || symbolName.length === 0) {
                    continue;
                }

                // Filter out compiler-generated symbols
                if (symbolName.startsWith('__') || symbolName.startsWith('$') || symbolName.startsWith('.')) {
                    continue;
                }

                // Determine scope: 0 = LOCAL, 1 = GLOBAL, 2 = WEAK
                let scope: 'local' | 'global' | 'static' = 'local';
                if (bind === 1) { // STB_GLOBAL
                    scope = 'global';
                } else if (bind === 0) { // STB_LOCAL
                    scope = 'local';
                } else if (bind === 2) { // STB_WEAK
                    scope = 'global';
                }

                variables.push({
                    name: symbolName,
                    address: this.normalizeAddress(`0x${value.toString(16)}`),
                    scope: scope,
                    type: type === 2 ? 'function' : 'variable',
                    size: size,
                });
            }

            return variables;

        } catch (error) {
            console.error('Error parsing ELF symbols:', error);
            return variables;
        }
    }

    /**
     * Helper to read null-terminated string from buffer
     */
    private static readNullTerminatedString(buffer: Buffer, offset: number): string {
        let end = offset;
        while (end < buffer.length && buffer[end] !== 0) {
            end++;
        }
        return buffer.toString('utf8', offset, end);
    }
}
