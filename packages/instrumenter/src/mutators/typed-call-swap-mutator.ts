import * as babel from '@babel/core';

import { NodeMutator } from './node-mutator.js';
import {
  isNamedMemberExpression,
  rangeOf,
} from '../util/typed-mutator-helpers.js';

const { types: t } = babel;

/**
 * Replaces a call with a call to a sibling function that accepts the same arguments and returns a compatible type.
 * Only active with type-aware mutation enabled.
 * @example
 * order.getShippingAddress() -> order.getBillingAddress()
 * formatDate(date) -> formatTime(date)
 */
export const typedCallSwapMutator: NodeMutator = {
  name: 'TypedCallSwap',

  *mutate(path, { typeOracle }) {
    if (
      !typeOracle ||
      !(path.isCallExpression() || path.isOptionalCallExpression())
    ) {
      return;
    }
    const { callee } = path.node;
    const isMember = isNamedMemberExpression(callee);
    const range = rangeOf(path.node);
    if (!range || !(isMember || t.isIdentifier(callee))) {
      return;
    }
    for (const { name } of typeOracle.siblingCallees(range)) {
      const replacement = t.cloneNode(path.node, true);
      if (isMember) {
        (replacement.callee as typeof callee).property = t.identifier(name);
      } else {
        replacement.callee = t.identifier(name);
      }
      yield replacement;
    }
  },
};
