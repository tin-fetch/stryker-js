import * as babel from '@babel/core';

import { NodeMutator } from './node-mutator.js';
import {
  isNamedMemberExpression,
  rangeOf,
} from '../util/typed-mutator-helpers.js';

const { types: t } = babel;

/**
 * Assigns to another writable variable or property of a compatible type.
 * Only active with type-aware mutation enabled.
 * @example
 * this.publishedAt = at -> this.deactivatedAt = at
 * total += price -> subtotal += price
 */
export const typedTargetSwapMutator: NodeMutator = {
  name: 'TypedTargetSwap',

  *mutate(path, { typeOracle }) {
    if (!typeOracle || !path.isAssignmentExpression()) {
      return;
    }
    const { left } = path.node;
    if (!(t.isIdentifier(left) || isNamedMemberExpression(left))) {
      return;
    }
    const range = rangeOf(left);
    if (!range) {
      return;
    }
    for (const { name } of typeOracle.alternativeTargets(range)) {
      const replacement = t.cloneNode(path.node, true);
      if (isNamedMemberExpression(replacement.left)) {
        replacement.left.property = t.identifier(name);
      } else {
        replacement.left = t.identifier(name);
      }
      yield replacement;
    }
  },
};
