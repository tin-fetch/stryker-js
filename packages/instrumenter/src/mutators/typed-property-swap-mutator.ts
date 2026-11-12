import * as babel from '@babel/core';

import { NodeMutator } from './node-mutator.js';
import { rangeOf } from '../util/typed-mutator-helpers.js';

const { types: t } = babel;

/**
 * Swaps the values of two properties of an object literal when both still fit the type of the other property.
 * The object literal needs a contextual type (e.g. it is passed as an argument, returned or assigned to a typed variable).
 * Only active with type-aware mutation enabled.
 * @example
 * schedule({ start: begin, end: finish }) -> schedule({ start: finish, end: begin })
 * schedule({ start, end }) -> schedule({ start: end, end: start })
 */
export const typedPropertySwapMutator: NodeMutator = {
  name: 'TypedPropertySwap',

  *mutate(path, { typeOracle }) {
    if (!typeOracle || !path.isObjectExpression()) {
      return;
    }
    const { properties } = path.node;
    const range = rangeOf(path.node);
    if (
      !range ||
      properties.filter((property) => t.isObjectProperty(property)).length < 2
    ) {
      return;
    }
    for (const [i, j] of typeOracle.swappablePropertyPairs(range)) {
      const a = properties[i];
      const b = properties[j];
      if (
        !t.isObjectProperty(a) ||
        !t.isObjectProperty(b) ||
        !t.isExpression(a.value) ||
        !t.isExpression(b.value)
      ) {
        continue;
      }
      const replacement = t.cloneNode(path.node, true);
      const replacementA = replacement.properties[
        i
      ] as babel.types.ObjectProperty;
      const replacementB = replacement.properties[
        j
      ] as babel.types.ObjectProperty;
      replacementA.value = t.cloneNode(b.value, true);
      replacementB.value = t.cloneNode(a.value, true);
      replacementA.shorthand = false;
      replacementB.shorthand = false;
      yield replacement;
    }
  },
};
