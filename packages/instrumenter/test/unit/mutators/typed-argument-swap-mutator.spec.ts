import { expect } from 'chai';

import { typedArgumentSwapMutator as sut } from '../../../src/mutators/typed-argument-swap-mutator.js';
import { expectJSMutation } from '../../helpers/expect-mutation.js';
import {
  expectTypedMutation,
  replaceLast,
} from '../../helpers/expect-typed-mutation.js';

describe(sut.name, () => {
  it('should have name "TypedArgumentSwap"', () => {
    expect(sut.name).eq('TypedArgumentSwap');
  });

  it('should not mutate without type information', () => {
    expectJSMutation(sut, 'range(1, 10)', { isExpressionContext: false });
  });

  it('should swap arguments of the same type', () => {
    const code = `declare function range(start: number, end: number): number[];
export const r = range(1, 10);`;
    expectTypedMutation(sut, code, [
      replaceLast(code, 'range(1, 10)', 'range(10, 1)'),
    ]);
  });

  it('should swap arguments of a constructor call', () => {
    const code = `declare class Rect { constructor(width: number, height: number) }
export const r = new Rect(1, 2);`;
    expectTypedMutation(sut, code, [
      replaceLast(code, 'Rect(1, 2)', 'Rect(2, 1)'),
    ]);
  });

  it('should only swap pairs that fit the other parameter', () => {
    const code = `declare function slice(text: string, start: number, end: number): string;
export const r = slice('abc', 1, 2);`;
    expectTypedMutation(sut, code, [
      replaceLast(code, "'abc', 1, 2", "'abc', 2, 1"),
    ]);
  });

  it('should not swap identical arguments', () => {
    expectTypedMutation(
      sut,
      `declare function range(start: number, end: number): number[];
declare const n: number;
export const r = range(n, n);`,
      [],
    );
  });

  it('should not swap arguments that are both part of the rest parameter', () => {
    expectTypedMutation(sut, 'export const r = Math.max(1, 2);', []);
  });
});
