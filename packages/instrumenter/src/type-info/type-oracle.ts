/**
 * A character range in the original source text, as found on Babel nodes (`node.start` / `node.end`).
 */
export interface SourceRange {
  start: number;
  end: number;
}

/**
 * A replacement name proposed by the type oracle, ranked by plausibility (higher is more plausible).
 */
export interface Candidate {
  name: string;
  score: number;
}

export type TypeShape = 'array' | 'nullable' | 'promise' | 'undefinedable';

/**
 * Answers type questions about a single source file.
 * Type-aware mutators use this, so they never touch the TypeScript compiler API directly.
 * All results are already filtered for type compatibility and capped to the configured maximum.
 */
export interface FileTypeOracle {
  /**
   * For a call `obj.f(...)` or `f(...)`: names of other callables that accept the same arguments and return a compatible type.
   */
  siblingCallees(call: SourceRange): Candidate[];
  /**
   * For a call or `new` expression: pairs of argument indices that can be swapped while staying type-correct.
   */
  swappableArgumentPairs(call: SourceRange): Array<[number, number]>;
  /**
   * For an identifier read: other in-scope variables of a compatible type.
   * For a property read `obj.p`: other (non-method) properties of `obj` of a compatible type.
   */
  alternativeValues(expression: SourceRange): Candidate[];
  /**
   * The type shapes of an expression, used to generate typed default values.
   */
  shapes(expression: SourceRange): TypeShape[];
}

/**
 * Answers type questions for a whole program.
 */
export interface TypeOracle {
  /**
   * Retrieve the oracle for one file. Returns `undefined` when the file isn't part of the program,
   * or when its content differs from the content the program was built with.
   */
  forFile(fileName: string, content: string): FileTypeOracle | undefined;
}
