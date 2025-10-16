# findSourceLocationForPC - Source Location Finding Algorithm

## Overview

The `findSourceLocationForPC` function is a critical component of the VS Code debugger extension that maps a Program Counter (PC) address to its corresponding source code location (file and line number). This enables the debugger to show users where the processor is currently executing in their source code.

**Location:** `/Users/evobidev/debugger/src/extension.ts:42`

## Purpose

When debugging embedded systems, the processor executes machine code at specific memory addresses. To provide a meaningful debugging experience, we need to translate these memory addresses back to the original source code. This function performs that translation by analyzing disassembly files.

## Algorithm Overview

The function uses a **two-path approach**:

1. **Fast Path:** Uses an in-memory address mapper for instant lookups
2. **Fallback Path:** Parses the disassembly file when the mapper is unavailable

---

## Detailed Algorithm

### Input Parameters

- `pcAddress` (string): The program counter address in hex format (e.g., "0x000002A4")
- `outputChannel` (vscode.OutputChannel): For logging debug information

### Return Value

Returns an object containing:
```typescript
{
  file: string,           // Source file path
  line: number,           // Line number in source file
  functionName?: string   // Optional function name at this address
}
```

Or `undefined` if the location cannot be found.

---

## Fast Path: Address Mapper Lookup

### Step 1: Check if Address Mapper is Available

```typescript
if (breakpointsViewProvider) {
  const addressMapper = (breakpointsViewProvider as any).addressMapper;

  if (addressMapper && addressMapper.isLoaded()) {
    // Fast path available
  }
}
```

**What it does:**
- Checks if the `addressMapper` is initialized and loaded into memory
- The address mapper is a pre-built data structure that stores mappings between addresses and source locations

### Step 2: Query the Address Mapper

```typescript
const result = addressMapper.getSourceLocationForAddress(pcAddress);
```

**What it does:**
- Performs an O(1) or O(log n) lookup in the pre-loaded mapping
- Returns immediately if found, avoiding expensive file I/O

**Advantages:**
- Extremely fast (microseconds)
- No file I/O required
- Efficient for repeated lookups

### Step 3: Log Diagnostic Information

```typescript
const stats = addressMapper.getStats();
outputChannel.appendLine(`Mapper has ${stats.totalMappings} mappings loaded`);

const sampleAddresses = addressMapper.getSampleAddresses(5);
outputChannel.appendLine(`Sample addresses in map: ${sampleAddresses.join(", ")}`);
```

**What it does:**
- Provides debugging information about the mapper state
- Shows sample addresses to help diagnose mapping issues

---

## Fallback Path: Disassembly File Parsing

When the fast path is unavailable, the function falls back to parsing the `full_disasm.txt` file.

### Step 1: Normalize the PC Address

```typescript
const cleanAddress = pcAddress.replace("0x", "").toLowerCase();
```

**What it does:**
- Removes the "0x" prefix
- Converts to lowercase for case-insensitive matching
- Example: "0x000002A4" → "2a4"

### Step 2: Locate the Disassembly File

```typescript
const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const disasmPath = `${workspaceFolder}/full_disasm.txt`;

if (!fs.existsSync(disasmPath)) {
  return undefined;
}

const content = fs.readFileSync(disasmPath, "utf8");
const lines = content.split("\n");
```

**What it does:**
- Finds the workspace root directory
- Constructs the path to `full_disasm.txt`
- Reads the entire disassembly file into memory
- Splits into lines for parsing

**File Format:** The disassembly file contains:
- Function definitions
- Assembly instructions
- Source code location comments

### Step 3: Find the Function at the Given Address

```typescript
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Look for function definition line
  const funcMatch = line.match(/^([0-9a-f]+)\s+<([^>]+)>:/);

  if (funcMatch) {
    const funcAddress = funcMatch[1];
    const funcName = funcMatch[2];

    if (parseInt(funcAddress, 16) === parseInt(cleanAddress, 16)) {
      functionName = funcName;
      break;
    }
  }
}
```

**What it does:**
- Scans through all lines looking for function definitions
- Function definitions follow the format: `000002a4 <DL_GPIO_clearPins>:`
- Uses regex to extract the address and function name
- Compares the function's start address with the target PC address

**Regex Breakdown:**
- `^([0-9a-f]+)` - Captures hex address at line start
- `\s+` - Matches whitespace
- `<([^>]+)>:` - Captures function name between angle brackets

**Example Match:**
```
000002a4 <DL_GPIO_clearPins>:
         ^^^^^ address    ^^^^^^^^^^^^^^^^ function name
```

### Step 4: Search for Call Sites (Backwards Search)

```typescript
for (let i = lines.length - 1; i >= 0; i--) {
  const line = lines[i];

  const callMatch = line.match(
    /^\s*([0-9a-f]+):\s+[0-9a-f\s]+\s+bl\s+0x([0-9a-f]+)\s+<([^>]+)>/
  );

  if (callMatch) {
    const callAddress = callMatch[1];
    const calledFunc = callMatch[3];

    if (calledFunc === functionName) {
      // Found a call to our function
    }
  }
}
```

**What it does:**
- Searches backwards through the file (from end to beginning)
- Looks for branch-and-link (`bl`) instructions that call the target function
- Branch-and-link is the ARM instruction for function calls

**Why Backwards?**
- The last call site found is typically the most recent one
- Provides better accuracy for recursive or frequently-called functions

**Instruction Format:**
```
     132: f000 f89f        bl    0x274 <DL_GPIO_setPins> @ imm = #0x13e
     ^^^  ^^^^^^^^         ^^    ^^^^^ ^^^^^^^^^^^^^^^^
     addr  hex bytes       inst  addr  function name
```

**Regex Breakdown:**
- `^\s*([0-9a-f]+):` - Captures instruction address
- `\s+[0-9a-f\s]+` - Matches hex bytes (instruction encoding)
- `\s+bl\s+` - Matches the "bl" (branch-and-link) instruction
- `0x([0-9a-f]+)` - Captures target address
- `<([^>]+)>` - Captures function name

### Step 5: Find Source Location Comment

```typescript
for (let j = i - 1; j >= Math.max(0, i - 20); j--) {
  const commentLine = lines[j];

  const sourceMatch = commentLine.match(/;\s*(.+):(\d+)\s*$/);

  if (sourceMatch) {
    const file = sourceMatch[1].trim();
    const lineNum = parseInt(sourceMatch[2], 10);

    return { file, line: lineNum, functionName };
  }
}
```

**What it does:**
- Once a call site is found, searches backwards up to 20 lines
- Looks for source location comments embedded by the compiler
- These comments indicate which source line generated the assembly

**Comment Format:**
```
; /path/to/file.c:60
```

**Why Search Up to 20 Lines?**
- Source comments may appear several instructions before the actual call
- The compiler may emit multiple instructions for a single source line
- Need to search backwards to find the originating source line

**Regex Breakdown:**
- `;\s*` - Matches semicolon (comment marker) and whitespace
- `(.+)` - Captures file path
- `:(\d+)` - Captures line number after colon
- `\s*$` - Matches trailing whitespace until end of line

---

## Error Handling

The function includes comprehensive error handling:

```typescript
try {
  // Algorithm implementation
} catch (error) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  outputChannel.appendLine(`Error parsing disassembly: ${errorMsg}`);
  return undefined;
}
```

**Error Scenarios:**
- Missing workspace folder
- Disassembly file not found
- Invalid file format
- Malformed addresses
- Missing function definitions

---

## Performance Considerations

### Fast Path Performance
- **Time Complexity:** O(1) to O(log n)
- **Space Complexity:** O(n) where n = number of mappings
- **Typical Speed:** < 1ms

### Fallback Path Performance
- **Time Complexity:** O(n) where n = lines in disassembly file
- **Space Complexity:** O(n) for file contents in memory
- **Typical Speed:** 10-100ms depending on file size

### Optimization Strategies
1. **Address Mapper:** Pre-load mappings to avoid repeated file I/O
2. **Backwards Search:** Start from end of file for recent calls
3. **Limited Search Window:** Only search 20 lines for source comments
4. **Early Exit:** Return immediately when match is found

---

## Integration Points

This function is called by:

1. **`showArrowAtPC()`** (line 229)
   - Shows visual indicator at current execution point
   - Highlights the line in the editor

2. **Halt Events** (multiple locations)
   - When processor is halted
   - When breakpoint is hit
   - After step operations

3. **Debug Event Handlers**
   - `onBreakpointHit()` (line 862)
   - `onStepCompleted()` (line 901)
   - `onHaltDetected()` (line 946)

---

## Example Usage

```typescript
const location = await findSourceLocationForPC("0x000002A4", outputChannel);

if (location) {
  console.log(`Found at: ${location.file}:${location.line}`);
  console.log(`Function: ${location.functionName}`);
  // Output: Found at: src/gpio.c:42
  //         Function: DL_GPIO_clearPins
}
```

---

## Disassembly File Format Example

```asm
; /home/user/project/src/gpio.c:60
     130: b580             push    {r7, lr}
     132: f000 f89f        bl      0x274 <DL_GPIO_setPins> @ imm = #0x13e

000002a4 <DL_GPIO_clearPins>:
; /home/user/project/src/gpio.c:42
     2a4: b580             push    {r7, lr}
     2a6: af00             add     r7, sp, #0
```

**Key Elements:**
1. **Source Comments:** `;` followed by file path and line number
2. **Instruction Lines:** Address, hex bytes, mnemonic, operands
3. **Function Headers:** Address in angle brackets with function name
4. **Branch Instructions:** `bl` (branch-and-link) with target address

---

## Limitations and Edge Cases

### Known Limitations

1. **Inlined Functions**
   - Inlined functions may not have explicit function headers
   - May return call site instead of actual function location

2. **Optimized Code**
   - Compiler optimizations can reorder or eliminate code
   - Source line mappings may be approximate

3. **Thumb Mode**
   - ARM Thumb mode uses bit 0 to indicate instruction set
   - Addresses may need normalization (handled by caller)

4. **Recursive Functions**
   - Multiple call sites exist for the same function
   - Returns the last (most recent) call site found

### Edge Cases

1. **Missing Disassembly File**
   - Returns `undefined` if file doesn't exist
   - Fallback gracefully to prevent crashes

2. **Address Not Found**
   - Returns `undefined` if no matching address
   - Logs diagnostic information for debugging

3. **Corrupted Disassembly**
   - Handles malformed lines gracefully
   - Continues searching rather than crashing

---

## Debugging Tips

### Enable Verbose Logging

The function logs extensively to help diagnose issues:

```typescript
outputChannel.appendLine(`Looking up PC address: ${pcAddress}`);
outputChannel.appendLine(`Found function at address: ${funcName} at ${funcAddress}`);
outputChannel.appendLine(`Found source location: ${file}:${lineNum}`);
```

### Check Address Mapper Stats

```typescript
const stats = addressMapper.getStats();
outputChannel.appendLine(`Mapper has ${stats.totalMappings} mappings loaded`);
```

### Verify Disassembly File

Ensure `full_disasm.txt` exists and contains:
- Function definitions with addresses
- Branch instructions with targets
- Source code location comments

---

## Future Improvements

Potential enhancements:

1. **Caching:** Cache disassembly parsing results
2. **Index Building:** Build an index for faster searches
3. **DWARF Support:** Use DWARF debug information if available
4. **Range Mapping:** Map address ranges instead of exact matches
5. **Symbol Table:** Use ELF symbol tables for faster lookups

---

## Related Functions

- **`showArrowAtPC()`** - Displays visual indicator in editor
- **`highlightBreakpointLine()`** - Highlights current breakpoint
- **`AddressMapper.getSourceLocationForAddress()`** - Fast path lookup

---

## References

- ARM Assembly Language Reference
- DWARF Debugging Information Format
- ELF File Format Specification
- VS Code Extension API Documentation
