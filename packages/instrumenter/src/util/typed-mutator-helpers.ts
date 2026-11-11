import * as babel from '@babel/core';
import type { NodePath } from '@babel/core';

import { SourceRange } from '../type-info/index.js';

const { types: t } = babel;

export function rangeOf(node: babel.types.Node): SourceRange | undefined {
  if (typeof node.start === 'number' && typeof node.end === 'number') {
    return { start: node.start, end: node.end };
  }
  return undefined;
}

/**
 * Whether the path is a non-computed member expression like `a.b` or `a?.b`.
 */
export function isNamedMemberExpression(
  node: babel.types.Node,
): node is (
  babel.types.MemberExpression | babel.types.OptionalMemberExpression
) & { property: babel.types.Identifier } {
  return (
    (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
    !node.computed &&
    t.isIdentifier(node.property)
  );
}

/**
 * Whether the path is an identifier or `a.b` member expression of which the value is read (and could thus be replaced by another value).
 * @example
 * foo(a, b.c) // `a` and `b.c` (and `b`) are value reads, `foo` is not (it's a callee)
 * a = b.c // `b.c` is a value read, `a` is not
 */
export function isValueRead(path: NodePath): boolean {
  const { node, parentPath } = path;
  if (!parentPath) {
    return false;
  }
  if (path.isIdentifier()) {
    if (!path.isReferencedIdentifier()) {
      return false;
    }
  } else if (!isNamedMemberExpression(node)) {
    return false;
  }
  const parent = parentPath.node;
  if (path.findParent((p) => p.isTSType() || p.isTSEntityName())) {
    // Part of a type annotation, e.g. `Promise` in `Promise<string>`
    return false;
  }
  return !(
    ((t.isCallExpression(parent) ||
      t.isOptionalCallExpression(parent) ||
      t.isNewExpression(parent)) &&
      parent.callee === node) ||
    (t.isAssignmentExpression(parent) && parent.left === node) ||
    t.isUpdateExpression(parent) ||
    (t.isUnaryExpression(parent) && parent.operator === 'delete') ||
    ((t.isForInStatement(parent) || t.isForOfStatement(parent)) &&
      parent.left === node) ||
    (t.isObjectProperty(parent) && parent.shorthand) ||
    t.isExportSpecifier(parent) ||
    (t.isTaggedTemplateExpression(parent) && parent.tag === node) ||
    t.isJSXAttribute(parent) ||
    t.isTSDeclareFunction(parent) ||
    t.isTSDeclareMethod(parent) ||
    t.isJSXMemberExpression(parent)
  );
}
