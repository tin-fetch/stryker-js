import * as babel from '@babel/core';
import type { NodePath } from '@babel/core';

import { TypeShape } from '../type-info/index.js';

import { NodeMutator } from './node-mutator.js';
import { isValueRead, rangeOf } from '../util/typed-mutator-helpers.js';

const { types: t } = babel;

const defaults: Record<TypeShape, () => babel.types.Expression> = {
  array: () => t.arrayExpression([]),
  undefinedable: () => t.identifier('undefined'),
  nullable: () => t.nullLiteral(),
  promise: () =>
    t.callExpression(
      t.memberExpression(t.identifier('Promise'), t.identifier('reject')),
      [
        t.newExpression(t.identifier('Error'), [
          t.stringLiteral('Stryker typed default'),
        ]),
      ],
    ),
};

/**
 * Replaces a value with a default value of its type, based on the static type of the expression.
 * Only active with type-aware mutation enabled.
 * @example
 * render(getItems()) -> render([])
 * greet(user.nickname) -> greet(undefined) // when `nickname` is `string | undefined`
 * await fetchUser(id) -> await Promise.reject(new Error("Stryker typed default"))
 */
export const typedDefaultMutator: NodeMutator = {
  name: 'TypedDefault',

  *mutate(path, { typeOracle }) {
    const range = rangeOf(path.node);
    if (!typeOracle || !range || !isCandidate(path)) {
      return;
    }
    for (const shape of typeOracle.shapes(range)) {
      yield defaults[shape]();
    }
  },
};

function isReceiverOfMethodCall(path: NodePath): boolean {
  const member = path.parentPath;
  const call = member?.parentPath;
  return (
    !!member &&
    (member.isMemberExpression() || member.isOptionalMemberExpression()) &&
    member.node.object === path.node &&
    !!call &&
    (call.isCallExpression() || call.isOptionalCallExpression()) &&
    call.node.callee === member.node
  );
}

function isCandidate(path: NodePath): boolean {
  if (path.parentPath?.isExpressionStatement()) {
    // Value is discarded anyway
    return false;
  }
  if (isReceiverOfMethodCall(path)) {
    // `[].push(x)` is a roundabout way of removing the call, which other mutators already cover
    return false;
  }
  return (
    path.isCallExpression() ||
    path.isOptionalCallExpression() ||
    isValueRead(path)
  );
}
