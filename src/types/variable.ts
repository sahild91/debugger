/**
 * Represents a single variable with its memory address
 */
export interface VariableInfo {
  /** Variable name */
  name: string;

  /** Memory address in hexadecimal format (e.g., "0x1234") */
  address: string;

  /** Line number where variable is defined/used (optional, 1-based) */
  line?: number;

  /** File path where variable is defined (optional) */
  filePath?: string;

  /** Variable scope type */
  scope: 'local' | 'global' | 'static' | 'argument';

  /** Data type of the variable (optional) */
  type?: string;

  /** Current value of the variable (optional) */
  value?: string;

  /** Size of the variable in bytes (optional) */
  size?: number;
}

/**
 * Variables data structure grouped by scope
 */
export interface VariablesData {
  /** Local variables in current scope */
  localVariables: VariableInfo[];

  /** Global and static variables */
  globalVariables: VariableInfo[];

  /** Total number of variables */
  totalCount: number;

  /** Whether the variables data is currently valid */
  isValid: boolean;
}

/**
 * Represents a single CPU register
 */
export interface RegisterData {
  /** Register name (e.g., "R0", "PC", "SP") */
  name: string;

  /** Register value in hexadecimal format */
  value: string;

  /** Human-readable description of the register */
  description?: string;
}

/**
 * Combined data for the Data View
 * Contains both CPU registers and program variables
 */
export interface DataViewContent {
  /** CPU registers */
  registers: RegisterData[];

  /** Local variables from current scope */
  localVariables: VariableInfo[];

  /** Global and static variables */
  globalVariables: VariableInfo[];

  /** Whether debug session is active */
  isDebugActive: boolean;
}