import { expect } from 'chai';

import { typedDefaultMutator as sut } from '../../../src/mutators/typed-default-mutator.js';
import { expectJSMutation } from '../../helpers/expect-mutation.js';
import {
  expectTypedMutation,
  replaceLast,
} from '../../helpers/expect-typed-mutation.js';

describe(sut.name, () => {
  it('should have name "TypedDefault"', () => {
    expect(sut.name).eq('TypedDefault');
  });

  it('should not mutate without type information', () => {
    expectJSMutation(sut, 'render(getItems())', { isExpressionContext: false });
  });

  it('should replace an array with an empty array', () => {
    const code = `declare function getItems(): string[];
declare function render(items: string[]): void;
render(getItems());`;
    expectTypedMutation(sut, code, [
      replaceLast(code, 'render(getItems())', 'render([])'),
    ]);
  });

  it('should replace an optional value with undefined', () => {
    const code = `declare const user: { nickname: string | undefined };
declare function greet(n: string | undefined): void;
greet(user.nickname);`;
    expectTypedMutation(sut, code, [
      replaceLast(code, 'user.nickname', 'undefined'),
    ]);
  });

  it('should replace a nullable value with null', () => {
    const code = `declare const user: { nickname: string | null };
declare function greet(n: string | null): void;
greet(user.nickname);`;
    expectTypedMutation(sut, code, [
      replaceLast(code, 'user.nickname', 'null'),
    ]);
  });

  it('should replace a promise with a rejected promise', () => {
    const code = `declare function fetchUser(): Promise<string>;
export async function main(): Promise<string> {
  return await fetchUser();
}`;
    expectTypedMutation(sut, code, [
      replaceLast(
        code,
        'fetchUser()',
        'Promise.reject(new Error("Stryker typed default"))',
      ),
    ]);
  });

  it('should not mutate when the value is discarded', () => {
    expectTypedMutation(
      sut,
      `declare function getItems(): string[];
getItems();`,
      [],
    );
  });
});
