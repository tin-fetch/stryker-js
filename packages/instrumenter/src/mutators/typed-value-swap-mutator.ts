import * as babel from '@babel/core';

import { NodeMutator } from './node-mutator.js';
import {
  isNamedMemberExpression,
  isValueRead,
  rangeOf,
} from '../util/typed-mutator-helpers.js';

const { types: t } = babel;

/**
 * Replaces a value with another value of the same type: an in-scope variable, or a sibling property.
 * Only active with type-aware mutation enabled.
 * @example
 * send(user.email) -> send(user.backupEmail)
 * clamp(min, value, max) -> clamp(min, max, max)
 */
export const typedValueSwapMutator: NodeMutator = {
  name: 'TypedValueSwap',

  *mutate(path, { typeOracle }) {
    const range = rangeOf(path.node);
    if (!typeOracle || !range || !isValueRead(path)) {
      return;
    }
    const { node } = path;
    for (const { name } of typeOracle.alternativeValues(range)) {
      if (isNamedMemberExpression(node)) {
        const replacement = t.cloneNode(node, true);
        replacement.property = t.identifier(name);
        yield replacement;
      } else {
        yield t.identifier(name);
      }
    }
  },
};
