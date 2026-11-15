import { expect } from 'chai';

import { typedCallSwapMutator as sut } from '../../../src/mutators/typed-call-swap-mutator.js';
import { expectJSMutation } from '../../helpers/expect-mutation.js';
import {
  expectTypedMutation,
  replaceLast,
} from '../../helpers/expect-typed-mutation.js';

describe(sut.name, () => {
  it('should have name "TypedCallSwap"', () => {
    expect(sut.name).eq('TypedCallSwap');
  });

  it('should not mutate without type information', () => {
    expectJSMutation(sut, 'order.getShippingAddress()', {
      isExpressionContext: false,
    });
  });

  it('should swap a method for a sibling method with the same signature', () => {
    const code = `interface Address { street: string }
declare const order: { getShippingAddress(): Address; getBillingAddress(): Address; getId(): number; cancel(reason: string): Address };
export const a = order.getShippingAddress();`;
    expectTypedMutation(sut, code, [
      replaceLast(
        code,
        'order.getShippingAddress()',
        'order.getBillingAddress()',
      ),
    ]);
  });

  it('should swap a function for another function in scope with the same signature', () => {
    const code = `declare function formatDate(d: Date): string;
declare function formatTime(d: Date): string;
declare function count(d: Date): number;
declare function format(): string;
export const s = formatDate(new Date());`;
    expectTypedMutation(sut, code, [
      replaceLast(code, 'formatDate(new Date())', 'formatTime(new Date())'),
    ]);
  });

  it('should swap imported functions', () => {
    const code = `import { min, max } from './math.js';
export const s = min(1, 2);`;
    expectTypedMutation(
      sut,
      code,
      [replaceLast(code, 'min(1, 2)', 'max(1, 2)')],
      {
        otherFiles: {
          'math.ts':
            'export function min(a: number, b: number) { return a < b ? a : b; }\nexport function max(a: number, b: number) { return a > b ? a : b; }',
        },
      },
    );
  });

  it('should ignore the return type when the result is discarded', () => {
    const code = `declare const logger: { info(msg: string): void; warn(msg: string): number; count(): void };
logger.info('x');`;
    expectTypedMutation(sut, code, [replaceLast(code, 'info', 'warn')]);
  });

  it('should not mutate calls on `any`', () => {
    expectTypedMutation(sut, 'declare const x: any;\nx.foo();', []);
  });

  it('should keep only the most similarly named candidates', () => {
    const code = `declare const order: { getShippingAddress(): string; getBillingAddress(): string; getStatus(): string; getNote(): string };
export const s = order.getShippingAddress();`;
    expectTypedMutation(
      sut,
      code,
      [replaceLast(code, 'getShippingAddress()', 'getBillingAddress()')],
      { maxCandidatesPerSite: 1 },
    );
  });

  describe('equivalent swaps', () => {
    it('should not swap near-equivalent siblings like find and findLast', () => {
      const code = `interface Item { id: string }
declare const items: { find(id: string): Item | undefined; findLast(id: string): Item | undefined; pick(id: string): Item | undefined };
export const item = items.find('a');`;
      expectTypedMutation(sut, code, [
        replaceLast(code, "items.find('a')", "items.pick('a')"),
      ]);
    });

    it('should not swap a copying method for its in-place counterpart on a new value', () => {
      const code = `interface List { sort(): List; toSorted(): List; shuffled(): List }
declare function load(): List;
export const sorted = load().toSorted();`;
      expectTypedMutation(sut, code, [
        replaceLast(code, 'load().toSorted()', 'load().shuffled()'),
      ]);
    });

    it('should swap a copying method for its in-place counterpart on a shared value', () => {
      const code = `interface List { sort(): List; toSorted(): List }
export function sorted(list: List): List {
  return list.toSorted();
}`;
      expectTypedMutation(sut, code, [
        replaceLast(code, 'list.toSorted()', 'list.sort()'),
      ]);
    });

    it('should only invert a date validity check', () => {
      const code = `declare const date: Date;
export const valid = Number.isFinite(date.getTime());`;
      expectTypedMutation(sut, code, [
        replaceLast(code, 'Number.isFinite', 'Number.isNaN'),
      ]);
    });

    it('should swap isSafeInteger for isInteger', () => {
      const code = `declare const n: number;
export const valid = Number.isSafeInteger(n);`;
      expectTypedMutation(sut, code, [
        replaceLast(code, 'Number.isSafeInteger', 'Number.isInteger'),
        replaceLast(code, 'Number.isSafeInteger', 'Number.isFinite'),
        replaceLast(code, 'Number.isSafeInteger', 'Number.isNaN'),
      ]);
    });

    it('should swap a discarded in-place call for its copying counterpart', () => {
      const code = `interface List { sort(): List; toSorted(): List }
declare const list: List;
list.sort();`;
      expectTypedMutation(sut, code, [
        replaceLast(code, 'list.sort()', 'list.toSorted()'),
      ]);
    });

    it('should swap a discarded call for a method that calls it when it is not a guard', () => {
      const code = `export class Store {
  private items: string[] = [];
  add(item: string): void {
    this.put(item);
  }
  put(item: string): void {
    this.items = [...this.items, item];
  }
  putTwice(item: string): void {
    this.put(item);
    this.put(item);
  }
}`;
      expectTypedMutation(sut, code, [
        replaceLast(
          code,
          '  add(item: string): void {\n    this.put(item);',
          '  add(item: string): void {\n    this.putTwice(item);',
        ),
        replaceLast(
          code,
          'this.put(item);\n    this.put(item);',
          'this.add(item);\n    this.put(item);',
        ),
        replaceLast(code, 'this.put(item);\n  }\n}', 'this.add(item);\n  }\n}'),
      ]);
    });

    it('should not call the enclosing method', () => {
      const code = `export class Counter {
  run(): number { return this.step(); }
  step(): number { return 1; }
  reset(): number { return 0; }
}`;
      expectTypedMutation(sut, code, [
        replaceLast(code, 'this.step()', 'this.reset()'),
      ]);
    });

    it('should not swap a discarded call for a predicate or a method that calls it', () => {
      const code = `declare function log(cents: number): void;
export class Money {
  constructor(private readonly cents: number) {}
  add(other: Money): Money {
    this.requireSame(other);
    return other;
  }
  requireSame(other: Money): void {
    if (other.cents < 0) throw new Error('negative');
  }
  isSame(other: Money): boolean {
    return other.cents === this.cents;
  }
  compareTo(other: Money): Money {
    this.requireSame(other);
    return other;
  }
  audit(other: Money): void {
    log(other.cents);
  }
}`;
      expectTypedMutation(sut, code, [
        replaceLast(
          code,
          'this.requireSame(other);\n    return other;\n  }\n  requireSame',
          'this.audit(other);\n    return other;\n  }\n  requireSame',
        ),
        replaceLast(
          code,
          'this.requireSame(other);\n    return other;\n  }\n  audit',
          'this.audit(other);\n    return other;\n  }\n  audit',
        ),
      ]);
    });
  });
});
