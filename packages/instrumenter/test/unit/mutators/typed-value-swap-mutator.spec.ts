import { expect } from 'chai';

import { typedValueSwapMutator as sut } from '../../../src/mutators/typed-value-swap-mutator.js';
import { expectJSMutation } from '../../helpers/expect-mutation.js';
import {
  expectTypedMutation,
  replaceLast,
} from '../../helpers/expect-typed-mutation.js';

describe(sut.name, () => {
  it('should have name "TypedValueSwap"', () => {
    expect(sut.name).eq('TypedValueSwap');
  });

  it('should not mutate without type information', () => {
    expectJSMutation(sut, 'send(user.email)', { isExpressionContext: false });
  });

  it('should swap a property for a sibling property of the same type', () => {
    const code = `declare function send(to: string): void;
declare const user: { email: string; backupEmail: string; age: number; greet(): string };
send(user.email);`;
    expectTypedMutation(sut, code, [
      replaceLast(code, 'user.email', 'user.backupEmail'),
    ]);
  });

  it('should swap variables of the same type', () => {
    const code = `export function clamp(min: number, value: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}`;
    const body = 'Math.min(Math.max(value, min), max)';
    expectTypedMutation(sut, code, [
      replaceLast(code, body, 'Math.min(Math.max(min, min), max)'),
      replaceLast(code, body, 'Math.min(Math.max(max, min), max)'),
      replaceLast(code, body, 'Math.min(Math.max(value, value), max)'),
      replaceLast(code, body, 'Math.min(Math.max(value, max), max)'),
      replaceLast(code, body, 'Math.min(Math.max(value, min), min)'),
      replaceLast(code, body, 'Math.min(Math.max(value, min), value)'),
    ]);
  });

  it('should not use variables that are declared later', () => {
    const code = `declare function use(n: number): void;
const a = 1;
const c = 3;
use(a);
const b = 2;`;
    expectTypedMutation(sut, code, [replaceLast(code, 'use(a)', 'use(c)')]);
  });

  it('should not swap values of a different type', () => {
    expectTypedMutation(
      sut,
      `declare const age: number;
declare const isAdmin: boolean;
declare function show(s: string): void;
show(String(age));`,
      [],
    );
  });

  it('should use imported values', () => {
    const code = `import { defaultTimeout, maxTimeout } from './config.js';
declare function wait(ms: number): void;
wait(defaultTimeout);`;
    expectTypedMutation(
      sut,
      code,
      [replaceLast(code, 'wait(defaultTimeout)', 'wait(maxTimeout)')],
      {
        otherFiles: {
          'config.ts':
            'export const defaultTimeout = 10;\nexport const maxTimeout = 20;',
        },
      },
    );
  });

  it('should not mutate assignment targets', () => {
    expectTypedMutation(
      sut,
      `let a = 1;
let b = 2;
a = 3;
b++;`,
      [],
    );
  });
});
