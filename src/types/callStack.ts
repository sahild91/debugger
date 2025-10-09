/**
 * Represents a single frame in the call stack
 */
export interface CallStackFrame {
  /** Frame index (0 = current/top frame) */
  index: number;

  /** Function name being executed */
  functionName: string;

  /** Absolute or relative file path */
  filePath?: string;

  /** Line number in the source file (1-based) */
  line?: number;

  /** Column number in the source file (optional) */
  column?: number;

  /** Memory address of the frame (e.g., "0x08000100") */
  address?: string;

  /** Whether this is external/system code (not user code) */
  isExternal?: boolean;

  /** Whether this is the currently executing frame */
  isCurrent?: boolean;

  /** Module or library name (optional) */
  module?: string;
}

/**
 * Call stack data structure
 */
export interface CallStack {
  /** Array of stack frames, ordered from current (0) to oldest */
  frames: CallStackFrame[];

  /** Total number of frames */
  totalFrames: number;

  /** Whether the call stack is currently valid */
  isValid: boolean;
}
