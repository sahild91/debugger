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
