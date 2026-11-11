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
});
