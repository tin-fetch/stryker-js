import { expect } from 'chai';

import { typedTargetSwapMutator as sut } from '../../../src/mutators/typed-target-swap-mutator.js';
import { expectJSMutation } from '../../helpers/expect-mutation.js';
import {
  expectTypedMutation,
  replaceLast,
} from '../../helpers/expect-typed-mutation.js';

describe(sut.name, () => {
  it('should have name "TypedTargetSwap"', () => {
    expect(sut.name).eq('TypedTargetSwap');
  });

  it('should not mutate without type information', () => {
    expectJSMutation(sut, 'this.a = b', { isExpressionContext: false });
  });

  it('should assign to a sibling property of the same type', () => {
    const code = `export class Bundle {
  publishedAt: Date | null = null;
  deactivatedAt: Date | null = null;
  count = 0;
  publish(at: Date) {
    this.publishedAt = at;
  }
}`;
    expectTypedMutation(sut, code, [
      replaceLast(code, 'this.publishedAt = at', 'this.deactivatedAt = at'),
    ]);
  });

  it('should only offer readonly properties inside the constructor', () => {
    const code = `export class Period {
  readonly start: Date;
  readonly end: Date;
  constructor(start: Date, end: Date) {
    this.start = start;
    this.end = end;
  }
  move(other: Period) {
    other.start.setTime(0);
  }
}`;
    expectTypedMutation(sut, code, [
      replaceLast(code, 'this.start = start', 'this.end = start'),
      replaceLast(code, 'this.end = end', 'this.start = end'),
    ]);
    expectTypedMutation(
      sut,
      `declare const period: { readonly start: Date; end: Date };
period.end = new Date();`,
      [],
    );
  });

  it('should not offer a getter without a setter', () => {
    expectTypedMutation(
      sut,
      `export class Counter {
  private value = 0;
  get doubled() { return this.value * 2; }
  increment() {
    this.value = 1;
  }
}`,
      [],
    );
  });

  it('should swap let variables and parameters, but not constants or variables declared later', () => {
    const code = `export function sum(prices: number[], discount: number) {
  const tax = 0;
  let total = 0;
  let subtotal = 0;
  total += prices.length;
  let late = 0;
  return total + subtotal + tax + late + discount;
}`;
    expectTypedMutation(sut, code, [
      replaceLast(code, 'total += prices.length', 'discount += prices.length'),
      replaceLast(code, 'total += prices.length', 'subtotal += prices.length'),
    ]);
  });

  it('should not offer a target that does not accept the assigned value', () => {
    expectTypedMutation(
      sut,
      `export class Pet {
  name = '';
  nickname: 'rex' | 'max' = 'rex';
  rename(name: string) {
    this.name = name;
  }
}`,
      [],
    );
  });
});
