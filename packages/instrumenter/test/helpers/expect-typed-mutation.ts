import path from 'path';

import ts from 'typescript';

import { NodeMutator } from '../../src/mutators/node-mutator.js';
import {
  createTypeOracleFromProgram,
  TypeOracle,
} from '../../src/type-info/index.js';

import { expectJSMutation } from './expect-mutation.js';

export const virtualRoot = path.resolve('/virtual-project');
const sourceFileName = path.join(virtualRoot, 'source.ts');

const compilerOptions: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts'],
  noEmit: true,
  types: [],
};

/**
 * Creates a type oracle backed by a real TypeScript program, with the source files kept in memory.
 * @param files Map of file names (relative to the virtual project root) to their content
 */
export function createInMemoryTypeOracle(
  files: Record<string, string>,
  maxCandidatesPerSite = 3,
): TypeOracle {
  const inMemory = new Map(
    Object.entries(files).map(([name, content]) => [
      path.join(virtualRoot, name).replace(/\\/g, '/'),
      content,
    ]),
  );
  const host = ts.createCompilerHost(compilerOptions);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const content = inMemory.get(fileName);
    return content === undefined
      ? getSourceFile(fileName, languageVersion, ...rest)
      : ts.createSourceFile(fileName, content, languageVersion, true);
  };
  host.fileExists = (fileName) =>
    inMemory.has(fileName) || fileExists(fileName);
  host.readFile = (fileName) => inMemory.get(fileName) ?? readFile(fileName);
  const { directoryExists } = host;
  host.directoryExists = (dir) =>
    [...inMemory.keys()].some((name) => name.startsWith(`${dir}/`)) ||
    (directoryExists?.(dir) ?? false);
  const program = ts.createProgram({
    rootNames: [...inMemory.keys()],
    options: compilerOptions,
    host,
  });
  const errors = ts.getPreEmitDiagnostics(program);
  if (errors.length) {
    throw new Error(
      `Test code has type errors: ${ts.formatDiagnostics(errors, host)}`,
    );
  }
  return createTypeOracleFromProgram(ts, program, { maxCandidatesPerSite });
}

/**
 * Same as `expectJSMutation`, but with type information for the original code (which must be type-correct, strict TypeScript).
 * @param otherFiles Additional files in the program (for example, to import from)
 */
export function expectTypedMutation(
  sut: NodeMutator,
  originalCode: string,
  expectedReplacements: string[],
  {
    otherFiles = {},
    maxCandidatesPerSite = 3,
  }: {
    otherFiles?: Record<string, string>;
    maxCandidatesPerSite?: number;
  } = {},
): void {
  const oracle = createInMemoryTypeOracle(
    { 'source.ts': originalCode, ...otherFiles },
    maxCandidatesPerSite,
  );
  const typeOracle = oracle.forFile(sourceFileName, originalCode);
  if (!typeOracle) {
    throw new Error('Type oracle not created for the source file');
  }
  expectJSMutation(
    sut,
    originalCode,
    { isExpressionContext: false, typeOracle },
    ...expectedReplacements,
  );
}

/**
 * Replaces the last occurrence of `search` (so declarations at the top of the test code stay intact).
 */
export function replaceLast(
  code: string,
  search: string,
  replacement: string,
): string {
  const index = code.lastIndexOf(search);
  if (index === -1) {
    throw new Error(`"${search}" not found in test code`);
  }
  return `${code.substring(0, index)}${replacement}${code.substring(index + search.length)}`;
}
