#!/usr/bin/env node
// @ts-check
/**
 * Evaluates type-aware ("Typed*") mutants against the regular ("primitive") mutants in a Stryker JSON report.
 *
 * Usage: node typed-mutant-eval.mjs [reports/mutation/mutation.json]
 *
 * Run Stryker with `"disableBail": true` and the `json` reporter, so `killedBy` contains *all* tests that kill a mutant.
 *
 * Reports, per mutator:
 * - Status counts and mutation score (detected / (detected + undetected), compile errors excluded)
 * - Redundant: killed typed mutants that are dynamically subsumed by a primitive mutant,
 *   i.e. there is a killed primitive mutant `p` with `killedBy(p) ⊆ killedBy(m)`: every test that catches `p` also catches `m`.
 *   A typed mutant that is not redundant adds information that the primitive mutants don't provide.
 * And lists typed mutants that survive at a location where all overlapping primitive mutants are killed.
 */
import fs from 'fs';

const reportFile = process.argv[2] ?? 'reports/mutation/mutation.json';
/** @type {{ files: Record<string, { mutants: any[] }> }} */
const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));

const mutants = Object.entries(report.files).flatMap(([fileName, file]) =>
  file.mutants.map((mutant) => ({ ...mutant, fileName })),
);
const isTyped = (/** @type {any} */ mutant) =>
  mutant.mutatorName.startsWith('Typed');
const typed = mutants.filter(isTyped);
const primitive = mutants.filter((mutant) => !isTyped(mutant));

if (!typed.length) {
  console.log(
    `No type-aware mutants found in ${reportFile}. Did you enable "mutator.typeAware.enabled"?`,
  );
  process.exit(1);
}

const killedPrimitives = primitive.filter(
  (mutant) => mutant.status === 'Killed' && mutant.killedBy?.length,
);
if (killedPrimitives.some((mutant) => mutant.killedBy.length > 1)) {
  // fine, this means bail was disabled
} else if (killedPrimitives.length > 1) {
  console.warn(
    'Warning: every killed mutant is killed by exactly one test. Was "disableBail" enabled? Subsumption numbers will be unreliable.\n',
  );
}

/**
 * @param {any} mutant
 */
function isRedundant(mutant) {
  if (mutant.status !== 'Killed' || !mutant.killedBy?.length) {
    return false;
  }
  const killers = new Set(mutant.killedBy);
  return killedPrimitives.some((/** @type {any} */ p) =>
    p.killedBy.every((/** @type {string} */ test) => killers.has(test)),
  );
}

/**
 * @param {any} a
 * @param {any} b
 */
function overlaps(a, b) {
  const before = (
    /** @type {{line: number, column: number}} */ x,
    /** @type {{line: number, column: number}} */ y,
  ) => x.line < y.line || (x.line === y.line && x.column <= y.column);
  return (
    a.fileName === b.fileName &&
    before(a.location.start, b.location.end) &&
    before(b.location.start, a.location.end)
  );
}

const detected = ['Killed', 'Timeout'];
const undetected = ['Survived', 'NoCoverage'];

/** @type {Record<string, Record<string, number | string>>} */
const table = {};
for (const group of [
  ...new Set(mutants.map((mutant) => mutant.mutatorName)),
].sort()) {
  const groupMutants = mutants.filter((m) => m.mutatorName === group);
  const count = (/** @type {string[]} */ statuses) =>
    groupMutants.filter((m) => statuses.includes(m.status)).length;
  const nrDetected = count(detected);
  const nrUndetected = count(undetected);
  const row = /** @type {Record<string, number | string>} */ ({
    total: groupMutants.length,
    killed: count(['Killed']),
    timeout: count(['Timeout']),
    survived: count(['Survived']),
    noCoverage: count(['NoCoverage']),
    compileError: count(['CompileError']),
    'score %': nrDetected + nrUndetected
      ? Number(((100 * nrDetected) / (nrDetected + nrUndetected)).toFixed(1))
      : '-',
  });
  if (group.startsWith('Typed')) {
    const killed = groupMutants.filter((m) => m.status === 'Killed');
    const redundant = killed.filter(isRedundant).length;
    row.redundant = redundant;
    row['nonRedundant %'] = killed.length
      ? Number(((100 * (killed.length - redundant)) / killed.length).toFixed(1))
      : '-';
  }
  table[group] = row;
}
console.log(`Report: ${reportFile}\n`);
console.table(table);

const survivorsWherePrimitivesDie = typed.filter((mutant) => {
  if (mutant.status !== 'Survived') {
    return false;
  }
  const neighbours = primitive.filter((p) => overlaps(p, mutant));
  return (
    neighbours.length > 0 &&
    neighbours.every((p) => detected.includes(p.status) || p.status === 'CompileError')
  );
});

const typedSurvivors = typed.filter((m) => m.status === 'Survived');
console.log(
  `\nType-aware mutants surviving where all overlapping primitive mutants are detected: ${survivorsWherePrimitivesDie.length} of ${typedSurvivors.length} typed survivors`,
);
for (const mutant of survivorsWherePrimitivesDie) {
  console.log(
    `  ${mutant.fileName}:${mutant.location.start.line}:${mutant.location.start.column} ${mutant.mutatorName} -> ${mutant.replacement}`,
  );
}
const otherSurvivors = typedSurvivors.filter(
  (m) => !survivorsWherePrimitivesDie.includes(m),
);
if (otherSurvivors.length) {
  console.log(`\nOther surviving type-aware mutants: ${otherSurvivors.length}`);
  for (const mutant of otherSurvivors) {
    console.log(
      `  ${mutant.fileName}:${mutant.location.start.line}:${mutant.location.start.column} ${mutant.mutatorName} -> ${mutant.replacement}`,
    );
  }
}
