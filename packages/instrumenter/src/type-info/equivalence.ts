import type ts from 'typescript';

type TS = typeof ts;

/**
 * Sibling methods that behave the same in almost every realistic use (for example `find` and `findLast` on a list with unique ids),
 * so swapping them mostly produces equivalent mutants.
 */
const NEAR_EQUIVALENT_METHODS: ReadonlyArray<readonly [string, string]> = [
  ['find', 'findLast'],
  ['findIndex', 'findLastIndex'],
  ['indexOf', 'lastIndexOf'],
];

/**
 * In-place methods and their copying counterparts. Swapping them only matters when the receiver is shared with other code.
 */
const IN_PLACE_AND_COPYING_METHODS: ReadonlyArray<readonly [string, string]> = [
  ['sort', 'toSorted'],
  ['reverse', 'toReversed'],
  ['splice', 'toSpliced'],
];

/**
 * `Number` checks. Called with a date's number (`Number.isFinite(date.getTime())`), they only tell whether the date is valid.
 */
const NUMBER_CHECKS = new Set([
  'isFinite',
  'isNaN',
  'isInteger',
  'isSafeInteger',
]);

/**
 * The `Number` checks that give the same answer for a date's number: `true` for a valid date and `false` for an invalid one.
 */
const DATE_VALIDITY_CHECKS = new Set([
  'isFinite',
  'isInteger',
  'isSafeInteger',
]);

/**
 * Functions that return a different value on every call.
 */
const NONDETERMINISTIC_CALLS = new Set([
  'Date.now',
  'Math.random',
  'performance.now',
  'crypto.randomUUID',
  'randomUUID',
]);

/**
 * How often a reference to a constant is replaced by its value when comparing values.
 */
const MAX_INLINE_DEPTH = 3;

/**
 * How deep to look for calls of the original in the body of a candidate.
 */
const MAX_CALL_DEPTH = 3;

function isPair(
  pairs: ReadonlyArray<readonly [string, string]>,
  a: string,
  b: string,
): boolean {
  return pairs.some(
    ([first, second]) =>
      (first === a && second === b) || (first === b && second === a),
  );
}

/**
 * Recognizes swaps that produce (almost certainly) equivalent mutants, so the type oracle can skip them.
 * These are heuristics, they only look at the code of the project itself and at a few well known library methods.
 */
export class EquivalenceFilter {
  private uniqueValues = 0;

  constructor(
    private readonly ts: TS,
    private readonly checker: ts.TypeChecker,
    private readonly program: ts.Program,
  ) {}

  /**
   * Whether no call swap should be generated at this call at all.
   * @example
   * Number.isFinite(date.getTime()) // `date.getTime()`: every date getter is NaN for an invalid date
   */
  public skipsCallSite(call: ts.CallExpression): boolean {
    const { ts } = this;
    if (this.isDateNumberCall(call)) {
      const parent = this.skipParentheses(call);
      return (
        ts.isCallExpression(parent.parent) && this.isNumberCheck(parent.parent)
      );
    }
    return false;
  }

  /**
   * Whether calling `candidateName` instead of the original callee is (most likely) equivalent or never terminates.
   * @param candidateSymbol The symbol of the candidate, when known
   * @param candidateType The type of the candidate at the call site
   * @param returnValueIsUsed Whether the result of the call is used
   */
  public isEquivalentCallSwap(
    call: ts.CallExpression,
    candidateName: string,
    candidateSymbol: ts.Symbol | undefined,
    candidateType: ts.Type,
    returnValueIsUsed: boolean,
  ): boolean {
    const { ts, checker } = this;
    const callee = call.expression;
    const originalName = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : undefined;
    if (originalName === undefined) {
      return false;
    }
    if (isPair(NEAR_EQUIVALENT_METHODS, originalName, candidateName)) {
      return true;
    }
    if (
      this.isNumberCheck(call) &&
      DATE_VALIDITY_CHECKS.has(originalName) &&
      DATE_VALIDITY_CHECKS.has(candidateName) &&
      call.arguments.some(
        (arg) => ts.isCallExpression(arg) && this.isDateNumberCall(arg),
      )
    ) {
      return true;
    }
    if (
      isPair(IN_PLACE_AND_COPYING_METHODS, originalName, candidateName) &&
      ts.isPropertyAccessExpression(callee) &&
      returnValueIsUsed &&
      this.isUnshared(callee.expression)
    ) {
      return true;
    }
    if (this.isRecursion(callee, candidateName)) {
      return true;
    }
    if (!returnValueIsUsed) {
      // When the result is thrown away, a predicate has no effect at all, which the CallExpression mutator already covers.
      // A candidate that calls an original guard (like `requireSameCurrency`) does the same check.
      const isPredicate = candidateType
        .getCallSignatures()
        .every(
          (signature) =>
            !!(
              checker.getReturnTypeOfSignature(signature).flags &
              ts.TypeFlags.BooleanLike
            ),
        );
      const originalSymbol = this.symbolOfCallee(callee);
      if (
        isPredicate ||
        (candidateSymbol &&
          originalSymbol &&
          this.isGuard(originalSymbol, MAX_CALL_DEPTH) &&
          this.calls(
            candidateSymbol,
            originalSymbol,
            MAX_CALL_DEPTH,
            new Set(),
          ))
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether replacing the value at `node` with `candidate` is (most likely) equivalent or never terminates.
   * @example
   * this._status -> this.status // when `get status() { return this._status; }`
   * Reason.a -> Reason.b // when `const Reason = { a: 'x', b: 'x' }`
   */
  public isEquivalentValueSwap(
    node: ts.Identifier | ts.PropertyAccessExpression,
    candidateName: string,
    candidateSymbol: ts.Symbol,
  ): boolean {
    const { ts, checker } = this;
    const originalSymbol = this.resolve(
      checker.getSymbolAtLocation(ts.isIdentifier(node) ? node : node.name),
    );
    if (ts.isPropertyAccessExpression(node)) {
      if (this.isRecursion(node, candidateName)) {
        return true;
      }
      const originalName = node.name.text;
      if (
        this.getterTarget(candidateSymbol) === originalName ||
        (originalSymbol && this.getterTarget(originalSymbol) === candidateName)
      ) {
        return true;
      }
    }
    const originalValue = originalSymbol && this.constantValue(originalSymbol);
    return (
      originalValue !== undefined &&
      originalValue === this.constantValue(candidateSymbol)
    );
  }

  /**
   * Whether both expressions have the same value, after replacing references to constants with their values.
   * @example
   * const Amount = z.int();
   * const Term = z.int().positive();
   * sameValue(`Term`, `Amount.positive()`) // true
   */
  public sameValue(a: ts.Expression, b: ts.Expression): boolean {
    return (
      this.canonical(a, MAX_INLINE_DEPTH) ===
      this.canonical(b, MAX_INLINE_DEPTH)
    );
  }

  /**
   * Whether the function behind the signature treats parameters `i` and `j` symmetrically,
   * meaning that swapping them in the body gives the same expression (up to the order of operands of commutative operators).
   * @example
   * function equal(left: Item, right: Item) { return left.id === right.id; }
   */
  public isSymmetric(signature: ts.Signature, i: number, j: number): boolean {
    const { ts, checker } = this;
    const declaration = signature.getDeclaration() as
      ts.SignatureDeclaration | undefined;
    if (
      !declaration ||
      !(
        ts.isFunctionDeclaration(declaration) ||
        ts.isMethodDeclaration(declaration) ||
        ts.isFunctionExpression(declaration) ||
        ts.isArrowFunction(declaration)
      ) ||
      !declaration.body
    ) {
      return false;
    }
    const parameterI = declaration.parameters[i] as
      ts.ParameterDeclaration | undefined;
    const parameterJ = declaration.parameters[j] as
      ts.ParameterDeclaration | undefined;
    if (
      !parameterI ||
      !parameterJ ||
      parameterI.dotDotDotToken ||
      parameterJ.dotDotDotToken ||
      !ts.isIdentifier(parameterI.name) ||
      !ts.isIdentifier(parameterJ.name)
    ) {
      return false;
    }
    const symbolI = checker.getSymbolAtLocation(parameterI.name);
    const symbolJ = checker.getSymbolAtLocation(parameterJ.name);
    if (!symbolI || !symbolJ) {
      return false;
    }
    const original = this.canonical(
      declaration.body,
      0,
      new Map([
        [symbolI, '#i'],
        [symbolJ, '#j'],
      ]),
    );
    const swapped = this.canonical(
      declaration.body,
      0,
      new Map([
        [symbolI, '#j'],
        [symbolJ, '#i'],
      ]),
    );
    return original === swapped;
  }

  /**
   * A canonical text for an expression: the structure of the syntax tree, with references to constants replaced by their values (up to `depth` times),
   * renamed symbols, and the operands of commutative operators in a fixed order.
   */
  private canonical(
    node: ts.Node,
    depth: number,
    renames?: ReadonlyMap<ts.Symbol, string>,
  ): string {
    const { ts } = this;
    if (ts.isParenthesizedExpression(node)) {
      return this.canonical(node.expression, depth, renames);
    }
    if (
      ts.isNewExpression(node) ||
      ts.isArrayLiteralExpression(node) ||
      ts.isObjectLiteralExpression(node) ||
      (ts.isCallExpression(node) &&
        NONDETERMINISTIC_CALLS.has(node.expression.getText()))
    ) {
      // Every evaluation creates a new (mutable) object or a different value
      return `#unique${this.uniqueValues++}`;
    }
    if (ts.isStringLiteralLike(node)) {
      return JSON.stringify(node.text);
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const symbol = this.valueSymbol(node);
      const rename = symbol && renames?.get(symbol);
      if (rename) {
        return rename;
      }
      const value = symbol && depth > 0 && this.constantInitializer(symbol);
      if (value) {
        return this.canonical(value, depth - 1, renames);
      }
      if (ts.isIdentifier(node)) {
        return node.text;
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      this.isCommutative(node.operatorToken.kind)
    ) {
      const operands = [
        this.canonical(node.left, depth, renames),
        this.canonical(node.right, depth, renames),
      ].sort();
      return `(${operands[0]} ${node.operatorToken.getText()} ${operands[1]})`;
    }
    const children: string[] = [];
    ts.forEachChild(node, (child) => {
      children.push(this.canonical(child, depth, renames));
    });
    if (!children.length) {
      return node.getText();
    }
    return `${ts.SyntaxKind[node.kind]}(${children.join(',')})`;
  }

  private isCommutative(kind: ts.SyntaxKind): boolean {
    const { SyntaxKind } = this.ts;
    return (
      kind === SyntaxKind.EqualsEqualsEqualsToken ||
      kind === SyntaxKind.ExclamationEqualsEqualsToken ||
      kind === SyntaxKind.EqualsEqualsToken ||
      kind === SyntaxKind.ExclamationEqualsToken ||
      kind === SyntaxKind.AmpersandAmpersandToken ||
      kind === SyntaxKind.BarBarToken ||
      kind === SyntaxKind.AsteriskToken ||
      kind === SyntaxKind.AmpersandToken ||
      kind === SyntaxKind.BarToken ||
      kind === SyntaxKind.CaretToken
    );
  }

  /**
   * The symbol of the value an identifier or property access refers to.
   */
  private valueSymbol(
    node: ts.Identifier | ts.PropertyAccessExpression,
  ): ts.Symbol | undefined {
    const { ts, checker } = this;
    if (
      ts.isIdentifier(node) &&
      ts.isShorthandPropertyAssignment(node.parent)
    ) {
      return this.resolve(
        checker.getShorthandAssignmentValueSymbol(node.parent),
      );
    }
    return this.resolve(
      checker.getSymbolAtLocation(ts.isIdentifier(node) ? node : node.name),
    );
  }

  /**
   * The canonical value of a constant, or `undefined` if the symbol isn't a constant.
   */
  private constantValue(symbol: ts.Symbol): string | undefined {
    const initializer = this.constantInitializer(this.resolve(symbol));
    return initializer && this.canonical(initializer, MAX_INLINE_DEPTH - 1);
  }

  /**
   * The initializer of a `const` variable, or of a property of an object literal assigned to a `const` variable.
   */
  private constantInitializer(
    symbol: ts.Symbol | undefined,
  ): ts.Expression | undefined {
    const { ts } = this;
    const declaration = symbol?.valueDeclaration;
    if (!declaration) {
      return undefined;
    }
    if (ts.isVariableDeclaration(declaration)) {
      return this.isConst(declaration) ? declaration.initializer : undefined;
    }
    if (ts.isPropertyAssignment(declaration)) {
      let container: ts.Node = declaration.parent;
      while (
        ts.isParenthesizedExpression(container.parent) ||
        ts.isAsExpression(container.parent) ||
        ts.isSatisfiesExpression(container.parent)
      ) {
        container = container.parent;
      }
      return ts.isVariableDeclaration(container.parent) &&
        this.isConst(container.parent)
        ? declaration.initializer
        : undefined;
    }
    return undefined;
  }

  private isConst(declaration: ts.VariableDeclaration): boolean {
    return !!(
      this.ts.getCombinedNodeFlags(declaration) & this.ts.NodeFlags.Const
    );
  }

  /**
   * The name of the property returned by a getter like `get status() { return this._status; }`.
   */
  private getterTarget(symbol: ts.Symbol): string | undefined {
    const { ts } = this;
    const getter = symbol.declarations?.find(ts.isGetAccessorDeclaration);
    const statements = getter?.body?.statements;
    if (statements?.length !== 1) {
      return undefined;
    }
    const [statement] = statements;
    if (
      ts.isReturnStatement(statement) &&
      statement.expression &&
      ts.isPropertyAccessExpression(statement.expression) &&
      statement.expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      return statement.expression.name.text;
    }
    return undefined;
  }

  /**
   * Whether using `candidateName` at `node` would refer to the member or function that `node` is in.
   * @example
   * get status() { return this._status; } // `this.status` here never terminates
   */
  private isRecursion(node: ts.Expression, candidateName: string): boolean {
    const { ts } = this;
    const isThisMember =
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword;
    if (!isThisMember && !ts.isIdentifier(node)) {
      return false;
    }
    for (let current = node.parent; current; current = current.parent) {
      if (
        ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)
      ) {
        return (
          isThisMember &&
          (ts.isIdentifier(current.name) ||
            ts.isPrivateIdentifier(current.name)) &&
          current.name.text === candidateName
        );
      }
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current)
      ) {
        return !isThisMember && current.name?.text === candidateName;
      }
      if (ts.isClassLike(current) || ts.isSourceFile(current)) {
        return false;
      }
    }
    return false;
  }

  /**
   * Whether a function or method only checks something: it throws or calls assertion functions (or other guards), but doesn't assign anything.
   * @example
   * private requireSameCurrency(other: Money): void { invariant(this.currency === other.currency, 'Different currencies'); }
   */
  private isGuard(symbol: ts.Symbol, depth: number): boolean {
    const { ts, checker } = this;
    const declarations = (symbol.declarations ?? []).filter(
      (declaration): declaration is ts.FunctionLikeDeclaration =>
        ts.isFunctionLike(declaration) &&
        'body' in declaration &&
        !!declaration.body,
    );
    if (depth === 0 || !declarations.length) {
      return false;
    }
    let isGuard = true;
    const visit = (node: ts.Node): void => {
      if (!isGuard) {
        return;
      }
      const isUpdate =
        (ts.isPrefixUnaryExpression(node) ||
          ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken);
      const isAssignment =
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      if (
        isUpdate ||
        isAssignment ||
        ts.isDeleteExpression(node) ||
        (ts.isReturnStatement(node) && node.expression)
      ) {
        isGuard = false;
        return;
      }
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        const predicate =
          signature && checker.getTypePredicateOfSignature(signature);
        const isAssertion =
          predicate?.kind === ts.TypePredicateKind.AssertsIdentifier ||
          predicate?.kind === ts.TypePredicateKind.AssertsThis;
        const callee = this.symbolOfCallee(node.expression);
        // Other calls might have side effects, the arguments of an assertion are only evaluated to check them
        isGuard = isAssertion || (!!callee && this.isGuard(callee, depth - 1));
        return;
      }
      ts.forEachChild(node, visit);
    };
    for (const { body } of declarations) {
      visit(body!);
    }
    return isGuard;
  }

  /**
   * Whether a function or method (transitively) calls `target`.
   */
  private calls(
    symbol: ts.Symbol,
    target: ts.Symbol,
    depth: number,
    visited: Set<ts.Symbol>,
  ): boolean {
    const { ts } = this;
    if (depth === 0 || visited.has(symbol)) {
      return false;
    }
    visited.add(symbol);
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) {
        return;
      }
      if (ts.isCallExpression(node)) {
        const callee = this.symbolOfCallee(node.expression);
        if (
          callee &&
          (callee === target || this.calls(callee, target, depth - 1, visited))
        ) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const declaration of symbol.declarations ?? []) {
      if (
        ts.isFunctionLike(declaration) &&
        'body' in declaration &&
        declaration.body &&
        !declaration.getSourceFile().isDeclarationFile
      ) {
        visit(declaration.body);
      }
    }
    return found;
  }

  private symbolOfCallee(callee: ts.Expression): ts.Symbol | undefined {
    const { ts, checker } = this;
    if (ts.isPropertyAccessExpression(callee)) {
      return this.resolve(checker.getSymbolAtLocation(callee.name));
    }
    if (ts.isIdentifier(callee)) {
      return this.resolve(checker.getSymbolAtLocation(callee));
    }
    return undefined;
  }

  /**
   * Whether no other code can see the value of the expression: a new array or object, or a local variable initialized with one.
   */
  private isUnshared(expression: ts.Expression): boolean {
    const { ts, checker } = this;
    while (ts.isParenthesizedExpression(expression)) {
      expression = expression.expression;
    }
    if (
      ts.isCallExpression(expression) ||
      ts.isArrayLiteralExpression(expression) ||
      ts.isNewExpression(expression)
    ) {
      return true;
    }
    if (ts.isIdentifier(expression)) {
      const declaration =
        checker.getSymbolAtLocation(expression)?.valueDeclaration;
      return (
        !!declaration &&
        ts.isVariableDeclaration(declaration) &&
        !!declaration.initializer &&
        this.functionOf(declaration) === this.functionOf(expression) &&
        this.functionOf(expression) !== undefined &&
        this.isUnshared(declaration.initializer)
      );
    }
    return false;
  }

  private functionOf(node: ts.Node): ts.Node | undefined {
    for (let current = node.parent; current; current = current.parent) {
      if (this.ts.isFunctionLike(current)) {
        return current;
      }
    }
    return undefined;
  }

  /**
   * `Number.isFinite(x)` and friends.
   */
  private isNumberCheck(call: ts.CallExpression): boolean {
    const { ts } = this;
    const callee = call.expression;
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Number' &&
      NUMBER_CHECKS.has(callee.name.text)
    );
  }

  /**
   * A call of a `Date` method that returns a number, like `date.getTime()`.
   */
  private isDateNumberCall(call: ts.CallExpression): boolean {
    const { ts, checker } = this;
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) {
      return false;
    }
    const symbol = checker.getTypeAtLocation(callee.expression).getSymbol();
    const declarationFile = symbol?.declarations?.[0]?.getSourceFile();
    return (
      symbol?.name === 'Date' &&
      !!declarationFile &&
      this.program.isSourceFileDefaultLibrary(declarationFile) &&
      !!(checker.getTypeAtLocation(call).flags & ts.TypeFlags.NumberLike)
    );
  }

  private skipParentheses(node: ts.Node): ts.Node {
    while (this.ts.isParenthesizedExpression(node.parent)) {
      node = node.parent;
    }
    return node;
  }

  private resolve(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    if (symbol && symbol.flags & this.ts.SymbolFlags.Alias) {
      return this.checker.getAliasedSymbol(symbol);
    }
    return symbol;
  }
}
