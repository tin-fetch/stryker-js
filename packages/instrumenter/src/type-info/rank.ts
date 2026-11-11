import { Candidate } from './type-oracle.js';

/**
 * Splits an identifier into lower-cased word tokens.
 * @example
 * tokenize('getShippingAddress') // ['get', 'shipping', 'address']
 * tokenize('MAX_RETRY_COUNT') // ['max', 'retry', 'count']
 */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z\d]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

/**
 * How plausible it is to confuse `original` with `candidate`, between 0 and 1.
 * Names that share words (`shippingAddress` vs `billingAddress`) or are spelled similarly (`slice` vs `splice`) are considered more likely to be confused.
 */
export function nameSimilarity(original: string, candidate: string): number {
  return Math.max(
    sharedWords(original, candidate),
    spellingSimilarity(original.toLowerCase(), candidate.toLowerCase()),
  );
}

/**
 * Jaccard similarity of the words in both names.
 */
function sharedWords(original: string, candidate: string): number {
  const a = new Set(tokenize(original));
  const b = new Set(tokenize(candidate));
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) {
      shared++;
    }
  }
  return shared / (a.size + b.size - shared);
}

/**
 * 1 - (Levenshtein distance / length of the longest string)
 */
function spellingSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) {
    return 1;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[b.length] / longest;
}

/**
 * Orders candidates from most to least plausible (ties broken by name, so the outcome is deterministic) and keeps the first `max`.
 */
export function rankCandidates(
  candidates: Iterable<Candidate>,
  max: number,
): Candidate[] {
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.name);
    if (!existing || existing.score < candidate.score) {
      unique.set(candidate.name, candidate);
    }
  }
  return [...unique.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, max);
}
