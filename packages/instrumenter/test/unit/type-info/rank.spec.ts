import { expect } from 'chai';

import {
  nameSimilarity,
  rankCandidates,
  tokenize,
} from '../../../src/type-info/index.js';

describe('rank', () => {
  describe(tokenize.name, () => {
    it('should split camelCase, PascalCase, snake_case and acronyms', () => {
      expect(tokenize('getShippingAddress')).deep.eq([
        'get',
        'shipping',
        'address',
      ]);
      expect(tokenize('MAX_RETRY_COUNT')).deep.eq(['max', 'retry', 'count']);
      expect(tokenize('parseHTTPResponse')).deep.eq([
        'parse',
        'http',
        'response',
      ]);
    });
  });

  describe(nameSimilarity.name, () => {
    it('should be 1 for names with the same words', () => {
      expect(nameSimilarity('shippingAddress', 'address_shipping')).eq(1);
    });
    it('should be 0 for names without shared words', () => {
      expect(nameSimilarity('min', 'value')).eq(0);
    });
    it('should be high for names that are spelled similarly', () => {
      expect(nameSimilarity('slice', 'splice')).closeTo(5 / 6, 0.001);
    });
    it('should be higher for names that share more words', () => {
      expect(nameSimilarity('getShippingAddress', 'getBillingAddress')).gt(
        nameSimilarity('getShippingAddress', 'getStatus'),
      );
    });
  });

  describe(rankCandidates.name, () => {
    it('should order by score, then name, and keep the top n', () => {
      expect(
        rankCandidates(
          [
            { name: 'b', score: 0.5 },
            { name: 'c', score: 0.9 },
            { name: 'a', score: 0.5 },
            { name: 'd', score: 0.1 },
          ],
          3,
        ).map(({ name }) => name),
      ).deep.eq(['c', 'a', 'b']);
    });
    it('should remove duplicate names', () => {
      expect(
        rankCandidates(
          [
            { name: 'a', score: 0.1 },
            { name: 'a', score: 0.5 },
          ],
          3,
        ),
      ).deep.eq([{ name: 'a', score: 0.5 }]);
    });
  });
});
