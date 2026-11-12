import * as babel from '@babel/core';
import type { NodePath } from '@babel/core';

import { NodeMutator } from './node-mutator.js';
import { rangeOf } from '../util/typed-mutator-helpers.js';

const { types: t } = babel;

/**
 * Replaces a string or number literal with another member of the literal union that is expected at that location.
 * Only active with type-aware mutation enabled.
 * @example
 * // with `status: 'active' | 'inactive' | 'pending'`
 * if (status === 'active') -> if (status === 'inactive')
 * setStatus('pending') -> setStatus('active')
 */
export const typedLiteralSwapMutator: NodeMutator = {
  name: 'TypedLiteralSwap',

  *mutate(path, { typeOracle }) {
    const range = rangeOf(path.node);
    if (!typeOracle || !range || !isCandidate(path)) {
      return;
    }
    for (const { value } of typeOracle.alternativeLiterals(range)) {
      yield typeof value === 'number'
        ? t.numericLiteral(value)
        : t.stringLiteral(value);
    }
  },
};

function isCandidate(path: NodePath): boolean {
  const { node, parent } = path;
  const isLiteral =
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    (t.isTemplateLiteral(node) && node.expressions.length === 0);
  if (!isLiteral || !parent) {
    return false;
  }
  const isKey =
    (t.isObjectMember(parent) ||
      t.isClassProperty(parent) ||
      t.isClassMethod(parent) ||
      t.isTSPropertySignature(parent)) &&
    parent.key === node &&
    !parent.computed;
  return !(
    isKey ||
    t.isImportDeclaration(parent) ||
    t.isExportAllDeclaration(parent) ||
    t.isExportNamedDeclaration(parent) ||
    t.isImportSpecifier(parent) ||
    t.isExportSpecifier(parent) ||
    t.isTSExternalModuleReference(parent) ||
    t.isTSModuleDeclaration(parent) ||
    t.isTSEnumMember(parent) ||
    t.isTSLiteralType(parent) ||
    // The `1` in `-1`
    (t.isUnaryExpression(parent) && parent.operator === '-') ||
    path.findParent((p) => p.isTSType()) !== null
  );
}
