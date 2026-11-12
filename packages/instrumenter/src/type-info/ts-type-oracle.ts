import path from 'path';

import type ts from 'typescript';
import type { Logger } from '@stryker-mutator/api/logging';

import { nameSimilarity, rankCandidates } from './rank.js';
import {
  Candidate,
  FileTypeOracle,
  LiteralCandidate,
  SourceRange,
  TypeOracle,
  TypeShape,
} from './type-oracle.js';

type TS = typeof ts;

export interface TypeOracleOptions {
  /** Maximum number of mutants a single typed mutator generates per site */
  maxCandidatesPerSite: number;
}

/**
 * Builds a type oracle using the TypeScript compiler API, based on the given tsconfig file.
 * Returns `undefined` (after logging a warning) when this isn't possible, in which case type-aware mutators generate nothing.
 */
export async function createTsTypeOracle(
  tsconfigFile: string,
  options: TypeOracleOptions,
  logger: Logger,
): Promise<TypeOracle | undefined> {
  let tsModule: TS;
  try {
    tsModule = (await import('typescript')).default;
  } catch {
    logger.warn(
      'Type-aware mutation is enabled, but the "typescript" package could not be loaded. No type-aware mutants will be generated.',
    );
    return undefined;
  }
  const configFileName = path.resolve(tsconfigFile);
  const { config, error } = tsModule.readConfigFile(
    configFileName,
    tsModule.sys.readFile,
  );
  if (error) {
    logger.warn(
      'Type-aware mutation is enabled, but tsconfig file "%s" could not be read: %s. No type-aware mutants will be generated.',
      configFileName,
      tsModule.flattenDiagnosticMessageText(error.messageText, '\n'),
    );
    return undefined;
  }
  const parsed = tsModule.parseJsonConfigFileContent(
    config,
    tsModule.sys,
    path.dirname(configFileName),
    undefined,
    configFileName,
  );
  if (parsed.projectReferences?.length) {
    logger.warn(
      'Type-aware mutation does not support project references yet. Only the files of "%s" itself are analyzed.',
      configFileName,
    );
  }
  const program = tsModule.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
    projectReferences: parsed.projectReferences,
  });
  logger.info(
    'Type-aware mutation: analyzing %d file(s) from "%s".',
    parsed.fileNames.length,
    path.relative(process.cwd(), configFileName),
  );
  return createTypeOracleFromProgram(tsModule, program, options);
}

/**
 * Creates a type oracle for an existing TypeScript program.
 */
export function createTypeOracleFromProgram(
  tsModule: TS,
  program: ts.Program,
  options: TypeOracleOptions,
): TypeOracle {
  const checker = program.getTypeChecker();
  return {
    forFile(fileName, content) {
      const sourceFile = program.getSourceFile(
        path.resolve(fileName).replace(/\\/g, '/'),
      );
      if (
        !sourceFile ||
        sourceFile.isDeclarationFile ||
        sourceFile.text !== content
      ) {
        return undefined;
      }
      return new TsFileTypeOracle(
        tsModule,
        program,
        checker,
        sourceFile,
        options.maxCandidatesPerSite,
      );
    },
  };
}

/**
 * The minimal name similarity for swapping a member declared in a library.
 * @see TsFileTypeOracle.memberCandidate
 */
const MIN_LIBRARY_MEMBER_SIMILARITY = 0.3;

/**
 * Simplified check (ASCII only) whether a property name can be used in a `obj.name` property access.
 */
function isIdentifierName(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

interface ScopeSymbol {
  /** The name to use at the location (the local name in case of an import) */
  name: string;
  /** The symbol after resolving import aliases */
  resolved: ts.Symbol;
  /** Whether the symbol is imported into this file */
  isImport: boolean;
}

type LiteralNode =
  ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.NumericLiteral;

class TsFileTypeOracle implements FileTypeOracle {
  constructor(
    private readonly ts: TS,
    private readonly program: ts.Program,
    private readonly checker: ts.TypeChecker,
    private readonly sourceFile: ts.SourceFile,
    private readonly max: number,
  ) {}

  public siblingCallees(range: SourceRange): Candidate[] {
    const { ts, checker } = this;
    const call = this.find(range, ts.isCallExpression);
    if (!call || call.arguments.some(ts.isSpreadElement)) {
      return [];
    }
    const argumentTypes = call.arguments.map((arg) =>
      checker.getTypeAtLocation(arg),
    );
    const returnValueIsUsed = !this.isDiscarded(call);
    const originalType = checker.getTypeAtLocation(call);
    if (returnValueIsUsed && this.isUseless(originalType)) {
      return [];
    }
    const isCompatible = (candidateType: ts.Type) =>
      !this.isUseless(candidateType) &&
      candidateType
        .getCallSignatures()
        .some(
          (signature) =>
            this.acceptsArguments(signature, argumentTypes, call) &&
            (!returnValueIsUsed ||
              this.valueFits(
                checker.getReturnTypeOfSignature(signature),
                originalType,
                call,
              )),
        );

    const callee = call.expression;
    const candidates: Candidate[] = [];
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      const originalName = callee.name.text;
      for (const property of this.propertiesOf(callee)) {
        const candidate = this.memberCandidate(originalName, property);
        if (
          candidate &&
          isCompatible(checker.getTypeOfSymbolAtLocation(property, callee))
        ) {
          candidates.push(candidate);
        }
      }
    } else if (ts.isIdentifier(callee)) {
      const originalSymbol = this.resolve(checker.getSymbolAtLocation(callee));
      for (const { name, resolved } of this.symbolsInScope(
        call,
        ts.SymbolFlags.Function | ts.SymbolFlags.Variable,
      )) {
        if (
          resolved !== originalSymbol &&
          isCompatible(checker.getTypeOfSymbolAtLocation(resolved, call))
        ) {
          candidates.push({
            name,
            score: nameSimilarity(callee.text, name),
          });
        }
      }
    }
    return rankCandidates(candidates, this.max);
  }

  public swappableArgumentPairs(range: SourceRange): Array<[number, number]> {
    const { ts, checker } = this;
    const call = this.find(
      range,
      (node): node is ts.CallExpression | ts.NewExpression =>
        ts.isCallExpression(node) || ts.isNewExpression(node),
    );
    const args = call?.arguments;
    if (!call || !args || args.length < 2 || args.some(ts.isSpreadElement)) {
      return [];
    }
    const signature = checker.getResolvedSignature(call);
    if (!signature) {
      return [];
    }
    const restIndex = this.restParameterIndex(signature);
    const argumentTypes = args.map((arg) => checker.getTypeAtLocation(arg));
    const parameterTypes = args.map((_, index) =>
      this.parameterType(signature, index, call),
    );
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < args.length; i++) {
      for (let j = i + 1; j < args.length; j++) {
        const parameterI = parameterTypes[i];
        const parameterJ = parameterTypes[j];
        const bothInRest =
          restIndex !== undefined && i >= restIndex && j >= restIndex;
        if (
          !bothInRest &&
          parameterI &&
          parameterJ &&
          !this.isUseless(argumentTypes[i]) &&
          !this.isUseless(argumentTypes[j]) &&
          !this.isUseless(parameterI) &&
          !this.isUseless(parameterJ) &&
          args[i].getText(this.sourceFile) !==
            args[j].getText(this.sourceFile) &&
          checker.isTypeAssignableTo(argumentTypes[i], parameterJ) &&
          checker.isTypeAssignableTo(argumentTypes[j], parameterI)
        ) {
          pairs.push([i, j]);
        }
      }
    }
    // Adjacent arguments are the most likely to be swapped by accident
    return pairs
      .sort(([i1, j1], [i2, j2]) => j1 - i1 - (j2 - i2) || i1 - i2)
      .slice(0, this.max);
  }

  public alternativeValues(range: SourceRange): Candidate[] {
    const { ts, checker } = this;
    const node = this.find(
      range,
      (n): n is ts.Identifier | ts.PropertyAccessExpression =>
        ts.isIdentifier(n) || ts.isPropertyAccessExpression(n),
    );
    if (!node || !this.isValuePosition(node)) {
      return [];
    }
    const originalType = checker.getTypeAtLocation(node);
    if (this.isUseless(originalType) || this.isFunctionLike(originalType)) {
      return [];
    }
    const candidates: Candidate[] = [];
    if (ts.isPropertyAccessExpression(node)) {
      if (!ts.isIdentifier(node.name)) {
        return [];
      }
      const originalName = node.name.text;
      for (const property of this.propertiesOf(node)) {
        const candidate = this.memberCandidate(originalName, property);
        if (!candidate) {
          continue;
        }
        const type = checker.getTypeOfSymbolAtLocation(property, node);
        if (
          !this.isFunctionLike(type) &&
          this.valueFits(type, originalType, node)
        ) {
          candidates.push(candidate);
        }
      }
    } else {
      const originalSymbol = this.resolve(checker.getSymbolAtLocation(node));
      if (!originalSymbol) {
        return [];
      }
      for (const { name, resolved } of this.symbolsInScope(
        node,
        ts.SymbolFlags.Variable,
      )) {
        if (resolved === originalSymbol) {
          continue;
        }
        const type = checker.getTypeOfSymbolAtLocation(resolved, node);
        if (
          !this.isFunctionLike(type) &&
          this.valueFits(type, originalType, node)
        ) {
          candidates.push({
            name,
            score: nameSimilarity(node.text, name),
          });
        }
      }
    }
    return rankCandidates(candidates, this.max);
  }

  public shapes(range: SourceRange): TypeShape[] {
    const { ts, checker } = this;
    const node = this.find(
      range,
      (
        n,
      ): n is ts.CallExpression | ts.Identifier | ts.PropertyAccessExpression =>
        ts.isCallExpression(n) ||
        ts.isIdentifier(n) ||
        ts.isPropertyAccessExpression(n),
    );
    if (!node || !this.isValuePosition(node)) {
      return [];
    }
    const type = checker.getTypeAtLocation(node);
    if (this.isUseless(type)) {
      return [];
    }
    const shapes: TypeShape[] = [];
    if (type.isUnion()) {
      const hasValue = type.types.some(
        (t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
      );
      if (
        hasValue &&
        type.types.some((t) => t.flags & ts.TypeFlags.Undefined)
      ) {
        shapes.push('undefinedable');
      }
      if (hasValue && type.types.some((t) => t.flags & ts.TypeFlags.Null)) {
        shapes.push('nullable');
      }
    }
    const nonNullable = checker.getNonNullableType(type);
    if (checker.isArrayType(nonNullable)) {
      shapes.push('array');
    } else if (this.isPromise(nonNullable)) {
      shapes.push('promise');
    }
    return shapes;
  }

  public alternativeLiterals(range: SourceRange): LiteralCandidate[] {
    const { ts } = this;
    const node = this.find(
      range,
      (n): n is LiteralNode =>
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isNumericLiteral(n),
    );
    if (!node || !this.isLiteralValue(node)) {
      return [];
    }
    const expected = this.expectedTypeOfLiteral(node);
    if (!expected) {
      return [];
    }
    const original = ts.isNumericLiteral(node) ? Number(node.text) : node.text;
    const members = (expected.isUnion() ? expected.types : [expected]).filter(
      (member) =>
        !(
          member.flags &
          (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)
        ),
    );
    const values = new Map<string, string | number>();
    for (const member of members) {
      const isSameKind =
        typeof original === 'number'
          ? member.isNumberLiteral()
          : member.isStringLiteral();
      if (!isSameKind || member.flags & ts.TypeFlags.EnumLiteral) {
        // Not a union of plain literals of the same kind (e.g. `'a' | number`, or an enum), no plausible siblings
        return [];
      }
      const { value } = member as ts.StringLiteralType | ts.NumberLiteralType;
      if (value !== original) {
        values.set(String(value), value);
      }
    }
    return rankCandidates(
      [...values.keys()].map((name) => ({
        name,
        score: nameSimilarity(String(original), name),
      })),
      this.max,
    ).map(({ name, score }) => ({ value: values.get(name)!, score }));
  }

  public swappablePropertyPairs(range: SourceRange): Array<[number, number]> {
    const { ts, checker } = this;
    const objectLiteral = this.find(range, ts.isObjectLiteralExpression);
    if (!objectLiteral) {
      return [];
    }
    const contextual = checker.getContextualType(objectLiteral);
    if (!contextual || this.isUseless(contextual)) {
      return [];
    }
    interface Entry {
      index: number;
      text: string;
      valueType: ts.Type;
      expected: ts.Type;
    }
    const entries: Entry[] = [];
    objectLiteral.properties.forEach((property, index) => {
      let value: ts.Expression | undefined;
      let valueType: ts.Type | undefined;
      if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ) {
        value = property.initializer;
        valueType = checker.getTypeAtLocation(value);
      } else if (
        ts.isShorthandPropertyAssignment(property) &&
        !property.objectAssignmentInitializer
      ) {
        value = property.name;
        const valueSymbol = checker.getShorthandAssignmentValueSymbol(property);
        valueType =
          valueSymbol && checker.getTypeOfSymbolAtLocation(valueSymbol, value);
      }
      const expected = value && checker.getContextualType(value);
      if (
        value &&
        valueType &&
        expected &&
        !this.isUseless(valueType) &&
        !this.isUseless(expected)
      ) {
        entries.push({
          index,
          text: value.getText(this.sourceFile),
          valueType,
          expected,
        });
      }
    });
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        if (
          a.text !== b.text &&
          checker.isTypeAssignableTo(a.valueType, b.expected) &&
          checker.isTypeAssignableTo(b.valueType, a.expected)
        ) {
          pairs.push([a.index, b.index]);
        }
      }
    }
    // Adjacent properties are the most likely to be mixed up
    return pairs
      .sort(([i1, j1], [i2, j2]) => j1 - i1 - (j2 - i2) || i1 - i2)
      .slice(0, this.max);
  }

  public alternativeTargets(range: SourceRange): Candidate[] {
    const { ts, checker } = this;
    const target = this.find(
      range,
      (n): n is ts.Identifier | ts.PropertyAccessExpression =>
        ts.isIdentifier(n) || ts.isPropertyAccessExpression(n),
    );
    const assignment = target?.parent;
    if (
      !target ||
      !assignment ||
      !ts.isBinaryExpression(assignment) ||
      assignment.left !== target ||
      assignment.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
      assignment.operatorToken.kind > ts.SyntaxKind.LastAssignment
    ) {
      return [];
    }
    const isPlainAssignment =
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    const targetType = checker.getTypeAtLocation(target);
    const valueType = checker.getTypeAtLocation(assignment.right);
    if (this.isUseless(targetType) || this.isUseless(valueType)) {
      return [];
    }
    const fits = (candidateType: ts.Type): boolean => {
      const widenedCandidate = checker.getBaseTypeOfLiteralType(candidateType);
      const widenedTarget = checker.getBaseTypeOfLiteralType(targetType);
      return (
        !this.isUseless(candidateType) &&
        checker.isTypeAssignableTo(widenedCandidate, widenedTarget) &&
        checker.isTypeAssignableTo(widenedTarget, widenedCandidate) &&
        (!isPlainAssignment ||
          checker.isTypeAssignableTo(valueType, candidateType))
      );
    };

    const candidates: Candidate[] = [];
    if (ts.isPropertyAccessExpression(target)) {
      if (!ts.isIdentifier(target.name)) {
        return [];
      }
      for (const property of this.propertiesOf(target)) {
        const candidate = this.memberCandidate(target.name.text, property);
        if (
          candidate &&
          !(property.flags & ts.SymbolFlags.Method) &&
          this.isWritable(property, target) &&
          fits(checker.getTypeOfSymbol(property))
        ) {
          candidates.push(candidate);
        }
      }
    } else {
      const originalSymbol = this.resolve(checker.getSymbolAtLocation(target));
      if (!originalSymbol) {
        return [];
      }
      for (const { name, resolved, isImport } of this.symbolsInScope(
        target,
        ts.SymbolFlags.Variable,
      )) {
        const declaration = resolved.valueDeclaration;
        if (
          isImport ||
          resolved === originalSymbol ||
          !declaration ||
          ts.getCombinedNodeFlags(declaration) &
            (ts.NodeFlags.Const | ts.NodeFlags.Using)
        ) {
          continue;
        }
        if (fits(checker.getTypeOfSymbol(resolved))) {
          candidates.push({ name, score: nameSimilarity(target.text, name) });
        }
      }
    }
    return rankCandidates(candidates, this.max);
  }

  /**
   * Whether the literal is used as a value, and not as a property name, module specifier, type, etc.
   */
  private isLiteralValue(node: LiteralNode): boolean {
    const { ts } = this;
    const { parent } = node;
    if (
      ts.isLiteralTypeNode(parent) ||
      ts.isImportDeclaration(parent) ||
      ts.isExportDeclaration(parent) ||
      ts.isExternalModuleReference(parent) ||
      ts.isImportTypeNode(parent) ||
      ts.isEnumMember(parent) ||
      ts.isElementAccessExpression(parent) ||
      ts.isExpressionStatement(parent)
    ) {
      return false;
    }
    if (ts.isBinaryExpression(parent) && parent.left === node) {
      // `'key' in obj`
      return parent.operatorToken.kind !== ts.SyntaxKind.InKeyword;
    }
    return (parent as { name?: ts.Node }).name !== node;
  }

  /**
   * The type expected at the location of a literal: the contextual type, or the type it is compared with.
   */
  private expectedTypeOfLiteral(node: LiteralNode): ts.Type | undefined {
    const { ts, checker } = this;
    const contextual = checker.getContextualType(node);
    if (contextual && !this.isUseless(contextual)) {
      return contextual;
    }
    let current: ts.Node = node;
    while (ts.isParenthesizedExpression(current.parent)) {
      current = current.parent;
    }
    const { parent } = current;
    const equalityOperators: ts.SyntaxKind[] = [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ];
    let expected: ts.Type | undefined;
    if (
      ts.isBinaryExpression(parent) &&
      equalityOperators.includes(parent.operatorToken.kind)
    ) {
      expected = checker.getTypeAtLocation(
        parent.left === current ? parent.right : parent.left,
      );
    } else if (ts.isCaseClause(parent) && parent.expression === current) {
      expected = checker.getTypeAtLocation(parent.parent.parent.expression);
    }
    return expected && !this.isUseless(expected) ? expected : undefined;
  }

  /**
   * Whether a property can be assigned at the location of `target`.
   * Readonly properties can only be assigned in the constructor of the class that declares them.
   */
  private isWritable(
    property: ts.Symbol,
    target: ts.PropertyAccessExpression,
  ): boolean {
    const { ts } = this;
    if (
      property.flags & ts.SymbolFlags.GetAccessor &&
      !(property.flags & ts.SymbolFlags.SetAccessor)
    ) {
      return false;
    }
    const declarations = property.declarations ?? [];
    const isReadonly = declarations.some(
      (declaration) =>
        ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly,
    );
    if (!isReadonly) {
      return true;
    }
    if (target.expression.kind !== ts.SyntaxKind.ThisKeyword) {
      return false;
    }
    let container: ts.Node | undefined = target.parent;
    while (
      container &&
      (!ts.isFunctionLike(container) || ts.isArrowFunction(container))
    ) {
      container = container.parent;
    }
    if (!container || !ts.isConstructorDeclaration(container)) {
      return false;
    }
    const constructor = container;
    return declarations.some(
      (declaration) =>
        declaration.parent === constructor.parent ||
        declaration.parent === constructor,
    );
  }

  /**
   * Finds the node matching the exact character range (excluding leading trivia), satisfying the predicate.
   */
  private find<T extends ts.Node>(
    range: SourceRange,
    predicate: (node: ts.Node) => node is T,
  ): T | undefined {
    const { ts, sourceFile } = this;
    let found: T | undefined;
    const visit = (node: ts.Node): void => {
      if (found) {
        return;
      }
      const start = node.getStart(sourceFile);
      if (start > range.start || node.end < range.end) {
        return;
      }
      if (start === range.start && node.end === range.end && predicate(node)) {
        found = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
    return found;
  }

  /**
   * Creates a candidate for a sibling member. Members of libraries (declared in a `.d.ts` file, like `Math` or `Array`) have many
   * unrelated siblings with the same signature (`Math.min` -> `Math.atan2`), so they need a similar name to be considered plausible.
   */
  private memberCandidate(
    originalName: string,
    property: ts.Symbol,
  ): Candidate | undefined {
    if (property.name === originalName) {
      return undefined;
    }
    const score = nameSimilarity(originalName, property.name);
    const isLibraryMember = !!property.declarations?.some(
      (declaration) => declaration.getSourceFile().isDeclarationFile,
    );
    if (isLibraryMember && score < MIN_LIBRARY_MEMBER_SIMILARITY) {
      return undefined;
    }
    return { name: property.name, score };
  }

  /**
   * Properties of the receiver of a property access that are accessible at that location.
   */
  private propertiesOf(access: ts.PropertyAccessExpression): ts.Symbol[] {
    const { checker } = this;
    const receiverType = checker.getTypeAtLocation(access.expression);
    if (this.isUseless(receiverType)) {
      return [];
    }
    return checker
      .getPropertiesOfType(checker.getApparentType(receiverType))
      .filter(
        (property) =>
          isIdentifierName(property.name) &&
          checker.isValidPropertyAccess(access, property.name),
      );
  }

  /**
   * Values in scope at the location that are declared by the user in this file (or imported into this file),
   * excluding everything that might not be initialized yet at that location.
   */
  private symbolsInScope(
    location: ts.Node,
    meaning: ts.SymbolFlags,
  ): ScopeSymbol[] {
    const { ts, checker } = this;
    const locationStart = location.getStart(this.sourceFile);
    const result: ScopeSymbol[] = [];
    for (const symbol of checker.getSymbolsInScope(
      location,
      meaning | ts.SymbolFlags.Alias,
    )) {
      const declaration = symbol.declarations?.[0];
      const resolved = this.resolve(symbol);
      if (
        !declaration ||
        !resolved ||
        !(resolved.flags & meaning) ||
        declaration.getSourceFile() !== this.sourceFile
      ) {
        continue;
      }
      const isImport = !!(symbol.flags & ts.SymbolFlags.Alias);
      const isHoistedFunction = ts.isFunctionDeclaration(declaration);
      const containsLocation =
        declaration.getStart(this.sourceFile) <= locationStart &&
        declaration.end >= location.end;
      const declaredBefore = declaration.end <= locationStart;
      if (
        isImport ||
        (isHoistedFunction && !containsLocation) ||
        declaredBefore
      ) {
        result.push({ name: symbol.name, resolved, isImport });
      }
    }
    return result;
  }

  private resolve(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    if (symbol && symbol.flags & this.ts.SymbolFlags.Alias) {
      return this.checker.getAliasedSymbol(symbol);
    }
    return symbol;
  }

  /**
   * Whether a value of type `candidate` can take the place of a value of type `original` at `site`.
   * Both types should be "the same kind of value" (mutually assignable after widening literal types),
   * and the candidate should fit the type that is expected at the site.
   */
  private valueFits(
    candidate: ts.Type,
    original: ts.Type,
    site: ts.Expression,
  ): boolean {
    const { checker } = this;
    const widenedCandidate = checker.getBaseTypeOfLiteralType(candidate);
    const widenedOriginal = checker.getBaseTypeOfLiteralType(original);
    if (this.isUseless(widenedCandidate) || this.isUseless(widenedOriginal)) {
      return false;
    }
    if (
      !checker.isTypeAssignableTo(widenedCandidate, widenedOriginal) ||
      !checker.isTypeAssignableTo(widenedOriginal, widenedCandidate)
    ) {
      return false;
    }
    const contextual = checker.getContextualType(site);
    const target =
      contextual && !this.isUseless(contextual) ? contextual : widenedOriginal;
    return checker.isTypeAssignableTo(candidate, target);
  }

  private acceptsArguments(
    signature: ts.Signature,
    argumentTypes: ts.Type[],
    location: ts.Node,
  ): boolean {
    if (signature.getTypeParameters()?.length) {
      // Generic signatures would need inference, not supported (yet)
      return false;
    }
    const parameters = signature.getParameters();
    const restIndex = this.restParameterIndex(signature);
    let required = 0;
    parameters.forEach((parameter, index) => {
      const declaration = parameter.valueDeclaration;
      const isOptional =
        declaration &&
        this.ts.isParameter(declaration) &&
        (declaration.dotDotDotToken ||
          this.checker.isOptionalParameter(declaration));
      if (!isOptional) {
        required = index + 1;
      }
    });
    if (argumentTypes.length < required) {
      return false;
    }
    if (restIndex === undefined && argumentTypes.length > parameters.length) {
      return false;
    }
    return argumentTypes.every((argumentType, index) => {
      const parameterType = this.parameterType(signature, index, location);
      return (
        parameterType !== undefined &&
        this.checker.isTypeAssignableTo(argumentType, parameterType)
      );
    });
  }

  private restParameterIndex(signature: ts.Signature): number | undefined {
    const parameters = signature.getParameters();
    const last = parameters[parameters.length - 1]?.valueDeclaration;
    if (last && this.ts.isParameter(last) && last.dotDotDotToken) {
      return parameters.length - 1;
    }
    return undefined;
  }

  private parameterType(
    signature: ts.Signature,
    index: number,
    location: ts.Node,
  ): ts.Type | undefined {
    const { checker } = this;
    const parameters = signature.getParameters();
    const restIndex = this.restParameterIndex(signature);
    if (restIndex !== undefined && index >= restIndex) {
      const restType = checker.getTypeOfSymbolAtLocation(
        parameters[restIndex],
        location,
      );
      if (checker.isArrayType(restType)) {
        return checker.getTypeArguments(restType as ts.TypeReference)[0];
      }
      return undefined;
    }
    const parameter = parameters[index] as ts.Symbol | undefined;
    return parameter && checker.getTypeOfSymbolAtLocation(parameter, location);
  }

  /**
   * Whether the node is used as a value (and not as a type or the name of a declaration).
   */
  private isValuePosition(node: ts.Node): boolean {
    const { ts } = this;
    const { parent } = node;
    if (
      ts.isTypeNode(parent) ||
      ts.isQualifiedName(parent) ||
      ts.isExpressionWithTypeArguments(parent)
    ) {
      return false;
    }
    if (ts.isIdentifier(node)) {
      const parentName = (parent as { name?: ts.Node }).name;
      return parentName !== node || ts.isShorthandPropertyAssignment(parent);
    }
    return true;
  }

  /**
   * Whether the value of the expression is thrown away, e.g. `foo();` as a statement.
   */
  private isDiscarded(expression: ts.Expression): boolean {
    const { ts } = this;
    let current: ts.Node = expression;
    while (ts.isParenthesizedExpression(current.parent)) {
      current = current.parent;
    }
    return (
      ts.isExpressionStatement(current.parent) ||
      ts.isVoidExpression(current.parent)
    );
  }

  private isPromise(type: ts.Type): boolean {
    const symbol = type.getSymbol();
    const declarationFile = symbol?.declarations?.[0]?.getSourceFile();
    return (
      symbol?.name === 'Promise' &&
      !!declarationFile &&
      this.program.isSourceFileDefaultLibrary(declarationFile)
    );
  }

  /**
   * Types that would make everything look compatible, so we don't generate mutants based on them.
   */
  private isUseless(type: ts.Type): boolean {
    return !!(
      type.flags &
      (this.ts.TypeFlags.Any |
        this.ts.TypeFlags.Unknown |
        this.ts.TypeFlags.Never)
    );
  }

  private isFunctionLike(type: ts.Type): boolean {
    return type.getCallSignatures().length > 0;
  }
}
