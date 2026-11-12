import { expect } from 'chai';

import { typedPropertySwapMutator as sut } from '../../../src/mutators/typed-property-swap-mutator.js';
import { expectJSMutation } from '../../helpers/expect-mutation.js';
import {
  expectTypedMutation,
  replaceLast,
} from '../../helpers/expect-typed-mutation.js';

const schedule = `interface Period { start: Date; end: Date; label: string }
declare function schedule(period: Period): void;
declare const begin: Date;
declare const finish: Date;`;

describe(sut.name, () => {
  it('should have name "TypedPropertySwap"', () => {
    expect(sut.name).eq('TypedPropertySwap');
  });

  it('should not mutate without type information', () => {
    expectJSMutation(sut, 'schedule({ start: a, end: b })', {
      isExpressionContext: false,
    });
  });

  it('should swap property values of the same type', () => {
    const code = `${schedule}
schedule({ start: begin, end: finish, label: 'x' });`;
    expectTypedMutation(sut, code, [
      replaceLast(
        code,
        "{ start: begin, end: finish, label: 'x' }",
        "{\n  start: finish,\n  end: begin,\n  label: 'x'\n}",
      ),
    ]);
  });

  it('should swap shorthand properties', () => {
    const code = `${schedule}
export function plan(start: Date, end: Date) {
  schedule({ start, end, label: 'x' });
}`;
    expectTypedMutation(sut, code, [
      replaceLast(
        code,
        "{ start, end, label: 'x' }",
        "{\n  start: end,\n  end: start,\n  label: 'x'\n}",
      ),
    ]);
  });

  it('should keep the indices right around a spread', () => {
    const code = `${schedule}
declare const defaults: Period;
schedule({ ...defaults, start: begin, end: finish });`;
    expectTypedMutation(sut, code, [
      replaceLast(
        code,
        '{ ...defaults, start: begin, end: finish }',
        '{\n  ...defaults,\n  start: finish,\n  end: begin\n}',
      ),
    ]);
  });

  it('should not swap without a contextual type', () => {
    expectTypedMutation(
      sut,
      `declare const begin: Date;
declare const finish: Date;
export const period = { start: begin, end: finish };`,
      [],
    );
  });

  it('should not swap identical values', () => {
    expectTypedMutation(
      sut,
      `${schedule}
schedule({ start: begin, end: begin, label: 'x' });`,
      [],
    );
  });

  it('should not swap a discriminant', () => {
    expectTypedMutation(
      sut,
      `type Shape = { kind: 'circle'; name: string } | { kind: 'square'; name: string };
declare function draw(shape: Shape): void;
declare const name: string;
draw({ kind: 'circle', name });`,
      [],
    );
  });
});
