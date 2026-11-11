import type { types, NodePath } from '@babel/core';
import { Mutable } from '../mutant.js';
import type { FileTypeOracle } from '../type-info/index.js';

export interface NodeMutatorContext {
  /** Script source was an expression */
  isExpressionContext: boolean;
  /** Type information for the current file, only available when type-aware mutation is enabled and the file is part of the TypeScript program */
  typeOracle?: FileTypeOracle;
}

export interface NodeMutator {
  mutate(
    path: NodePath,
    mutateContext: NodeMutatorContext,
  ): Iterable<types.Node>;
  filter?(mutantsInScope: Mutable[]): boolean;
  readonly name: string;
}
