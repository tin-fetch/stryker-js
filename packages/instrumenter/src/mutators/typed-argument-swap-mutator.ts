import * as babel from '@babel/core';

import { NodeMutator } from './node-mutator.js';
import { rangeOf } from '../util/typed-mutator-helpers.js';

const { types: t } = babel;

/**
 * Swaps two arguments of a call when both still fit the type of the other parameter.
 * Only active with type-aware mutation enabled.
 * @example
 * range(start, end) -> range(end, start)
 * new Rectangle(width, height) -> new Rectangle(height, width)
 */
export const typedArgumentSwapMutator: NodeMutator = {
  name: 'TypedArgumentSwap',

  *mutate(path, { typeOracle }) {
    if (
      !typeOracle ||
      !(
        path.isCallExpression() ||
        path.isOptionalCallExpression() ||
        path.isNewExpression()
      )
    ) {
      return;
    }
    const args = path.node.arguments;
    const range = rangeOf(path.node);
    if (!range || args.length < 2 || args.some((arg) => !t.isExpression(arg))) {
      return;
    }
    for (const [i, j] of typeOracle.swappableArgumentPairs(range)) {
      const replacement = t.cloneNode(path.node, true);
      replacement.arguments[i] = t.cloneNode(args[j], true);
      replacement.arguments[j] = t.cloneNode(args[i], true);
      yield replacement;
    }
  },
};
