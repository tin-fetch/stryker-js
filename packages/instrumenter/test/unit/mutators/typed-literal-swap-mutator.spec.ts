import { expect } from 'chai';

import { typedLiteralSwapMutator as sut } from '../../../src/mutators/typed-literal-swap-mutator.js';
import { expectJSMutation } from '../../helpers/expect-mutation.js';
import {
  expectTypedMutation,
  replaceLast,
} from '../../helpers/expect-typed-mutation.js';

const status = `type Status = 'active' | 'inactive' | 'pending';`;

describe(sut.name, () => {
  it('should have name "TypedLiteralSwap"', () => {
    expect(sut.name).eq('TypedLiteralSwap');
  });

  it('should not mutate without type information', () => {
    expectJSMutation(sut, "setStatus('active')", {
      isExpressionContext: false,
    });
  });

  it('should swap an argument with the other members of the expected union, most similar first', () => {
    const code = `${status}
declare function setStatus(status: Status): void;
setStatus('active');`;
    expectTypedMutation(sut, code, [
      replaceLast(code, "'active'", '"inactive"'),
      replaceLast(code, "'active'", '"pending"'),
    ]);
  });

  it('should cap the number of candidates', () => {
    const code = `${status}
declare function setStatus(status: Status): void;
setStatus('active');`;
    expectTypedMutation(
      sut,
      code,
      [replaceLast(code, "'active'", '"inactive"')],
      { maxCandidatesPerSite: 1 },
    );
  });

  it('should swap a return value and a property value', () => {
    const code = `${status}
export function initial(): Status { return 'pending'; }`;
    expectTypedMutation(sut, code, [
      replaceLast(code, "'pending'", '"active"'),
      replaceLast(code, "'pending'", '"inactive"'),
    ]);
    const objectCode = `${status}
export const user: { status: Status } = { status: 'pending' };`;
    expectTypedMutation(sut, objectCode, [
      replaceLast(objectCode, "'pending'", '"active"'),
      replaceLast(objectCode, "'pending'", '"inactive"'),
    ]);
  });

  it('should swap the operand of a comparison', () => {
    const code = `${status}
declare const current: Status;
export const isActive = current === 'active';`;
    expectTypedMutation(sut, code, [
      replaceLast(code, "'active'", '"inactive"'),
      replaceLast(code, "'active'", '"pending"'),
    ]);
  });

  it('should swap a case label', () => {
    const code = `${status}
declare const current: Status;
switch (current) {
  case 'pending':
    break;
}`;
    expectTypedMutation(sut, code, [
      replaceLast(code, "'pending'", '"active"'),
      replaceLast(code, "'pending'", '"inactive"'),
    ]);
  });

  it('should swap numeric literals', () => {
    const code = `declare function roll(value: 1 | 2 | 3): void;
roll(2);`;
    expectTypedMutation(sut, code, [
      replaceLast(code, '2)', '1)'),
      replaceLast(code, '2)', '3)'),
    ]);
  });

  it('should ignore an optional (undefined) member of the union', () => {
    const code = `declare function setStatus(status?: 'on' | 'off'): void;
setStatus('on');`;
    expectTypedMutation(sut, code, [replaceLast(code, "'on'", '"off"')]);
  });

  it('should not swap a literal where any string is expected', () => {
    expectTypedMutation(
      sut,
      `declare function greet(name: string): void;
greet('world');`,
      [],
    );
  });

  it('should not swap a literal in a union with other kinds of types', () => {
    expectTypedMutation(
      sut,
      `declare function size(value: 'small' | 'large' | number): void;
size('small');`,
      [],
    );
  });

  it('should not swap object keys, import sources or types', () => {
    expectTypedMutation(
      sut,
      `${status}
import type {} from './other.js';
export const lookup: Record<Status, number> = { 'active': 1, inactive: 2, pending: 3 };
export let s: 'active' = 'active';`,
      [],
      { otherFiles: { 'other.ts': 'export {};' } },
    );
  });
});
