// @ts-check
/**
 * Analysis and HTML rendering for the type-aware mutation benchmark (see typed-benchmark.mjs).
 *
 * Compares a baseline Stryker JSON report (primitive mutators only) with a type-aware run (primitive + Typed* mutators):
 * - Status counts and mutation score per run and per mutator
 * - Consistency of the primitive mutants between both runs
 * - Dynamic subsumption: a killed typed mutant `m` is redundant when a killed primitive mutant `p` has `killedBy(p) ⊆ killedBy(m)`
 * - Typed mutants that survive where every overlapping primitive mutant is detected (the most interesting signal)
 */

/** @typedef {{ line: number, column: number }} Position */
/** @typedef {{ start: Position, end: Position }} Location */
/** @typedef {{ id: string, mutatorName: string, replacement?: string, status: string, location: Location, killedBy?: string[], coveredBy?: string[], fileName: string }} Mutant */
/** @typedef {{ files: Record<string, { source: string, mutants: any[] }> }} Report */

const DETECTED = ['Killed', 'Timeout'];
const UNDETECTED = ['Survived', 'NoCoverage'];

/** @param {Mutant} mutant */
export const isTyped = (mutant) => mutant.mutatorName.startsWith('Typed');

/**
 * @param {Report} report
 * @returns {Mutant[]}
 */
export function mutantsOf(report) {
  return Object.entries(report.files).flatMap(([fileName, file]) =>
    file.mutants.map((mutant) => ({ ...mutant, fileName })),
  );
}

/** @param {Mutant} m */
const keyOf = (m) =>
  `${m.fileName}:${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column} ${m.mutatorName} ${m.replacement}`;

/** @param {Mutant[]} mutants */
function statusCounts(mutants) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const m of mutants) counts[m.status] = (counts[m.status] ?? 0) + 1;
  const detected = DETECTED.reduce((n, s) => n + (counts[s] ?? 0), 0);
  const undetected = UNDETECTED.reduce((n, s) => n + (counts[s] ?? 0), 0);
  const covered = detected + (counts.Survived ?? 0);
  return {
    total: mutants.length,
    killed: counts.Killed ?? 0,
    timeout: counts.Timeout ?? 0,
    survived: counts.Survived ?? 0,
    noCoverage: counts.NoCoverage ?? 0,
    compileError: counts.CompileError ?? 0,
    runtimeError: counts.RuntimeError ?? 0,
    ignored: counts.Ignored ?? 0,
    score:
      detected + undetected
        ? (100 * detected) / (detected + undetected)
        : undefined,
    coveredScore: covered ? (100 * detected) / covered : undefined,
  };
}

/** @param {Mutant} a @param {Mutant} b */
function overlaps(a, b) {
  /** @param {Position} x @param {Position} y */
  const before = (x, y) =>
    x.line < y.line || (x.line === y.line && x.column <= y.column);
  return (
    a.fileName === b.fileName &&
    before(a.location.start, b.location.end) &&
    before(b.location.start, a.location.end)
  );
}

/**
 * @param {Report | undefined} baselineReport
 * @param {Report} typedReport
 */
export function analyze(baselineReport, typedReport) {
  const typedRun = mutantsOf(typedReport);
  const typed = typedRun.filter(isTyped);
  const primitive = typedRun.filter((m) => !isTyped(m));

  const killedPrimitives = primitive.filter(
    (m) => m.status === 'Killed' && m.killedBy?.length,
  );
  const bailSuspected =
    killedPrimitives.length > 1 &&
    killedPrimitives.every((m) => m.killedBy?.length === 1);

  /** @param {Mutant} m */
  const isRedundant = (m) => {
    if (m.status !== 'Killed' || !m.killedBy?.length) return false;
    const killers = new Set(m.killedBy);
    return killedPrimitives.some((p) =>
      p.killedBy?.every((test) => killers.has(test)),
    );
  };

  const mutatorNames = [...new Set(typedRun.map((m) => m.mutatorName))].sort();
  const perMutator = mutatorNames.map((name) => {
    const group = typedRun.filter((m) => m.mutatorName === name);
    const killed = group.filter((m) => m.status === 'Killed');
    const redundant = name.startsWith('Typed')
      ? killed.filter(isRedundant).length
      : undefined;
    return {
      name,
      typed: name.startsWith('Typed'),
      ...statusCounts(group),
      redundant,
      nonRedundantPct:
        redundant !== undefined && killed.length
          ? (100 * (killed.length - redundant)) / killed.length
          : undefined,
    };
  });

  /** @param {Mutant} m */
  const withContext = (m) => ({
    ...m,
    original: sourceLine(typedReport, m),
    neighbours: primitive.filter((p) => overlaps(p, m)).length,
  });
  const typedSurvivors = typed.filter((m) => m.status === 'Survived');
  const survivorsWherePrimitivesDie = typedSurvivors.filter((m) => {
    const neighbours = primitive.filter((p) => overlaps(p, m));
    return (
      neighbours.length > 0 &&
      neighbours.every(
        (p) => DETECTED.includes(p.status) || p.status === 'CompileError',
      )
    );
  });
  const otherSurvivors = typedSurvivors.filter(
    (m) => !survivorsWherePrimitivesDie.includes(m),
  );

  /** @type {undefined | { baseline: ReturnType<typeof statusCounts>, same: number, changed: Array<{ key: string, from: string, to: string }>, onlyInTyped: string[], onlyInBaseline: string[] }} */
  let consistency;
  /** @type {ReturnType<typeof statusCounts> | undefined} */
  let baseline;
  if (baselineReport) {
    const baselineMutants = mutantsOf(baselineReport);
    baseline = statusCounts(baselineMutants);
    const byKey = new Map(baselineMutants.map((m) => [keyOf(m), m]));
    const primitiveKeys = new Set(primitive.map(keyOf));
    let same = 0;
    /** @type {Array<{ key: string, from: string, to: string }>} */
    const changed = [];
    /** @type {string[]} */
    const onlyInTyped = [];
    for (const m of primitive) {
      const b = byKey.get(keyOf(m));
      if (!b) onlyInTyped.push(keyOf(m));
      else if (b.status === m.status) same++;
      else changed.push({ key: keyOf(m), from: b.status, to: m.status });
    }
    const onlyInBaseline = baselineMutants
      .filter((m) => !primitiveKeys.has(keyOf(m)))
      .map(keyOf);
    consistency = { baseline, same, changed, onlyInTyped, onlyInBaseline };
  }

  return {
    baseline,
    typedRun: statusCounts(typedRun),
    typedRunPrimitive: statusCounts(primitive),
    typedOnly: statusCounts(typed),
    redundantTotal: typed.filter(isRedundant).length,
    killedTyped: typed.filter((m) => m.status === 'Killed').length,
    bailSuspected,
    perMutator,
    consistency,
    survivorsWherePrimitivesDie: survivorsWherePrimitivesDie.map(withContext),
    otherSurvivors: otherSurvivors.map(withContext),
  };
}

/** @param {Report} report @param {Mutant} m */
function sourceLine(report, m) {
  const source = report.files[m.fileName]?.source;
  return source?.split(/\r?\n/)[m.location.start.line - 1] ?? '';
}

/** @param {unknown} value */
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] ?? c,
  );

/** @param {number | undefined} n */
const pct = (n) => (n === undefined ? '–' : `${n.toFixed(1)}%`);

/** @param {number | undefined} ms */
const duration = (ms) => {
  if (ms === undefined) return '–';
  const minutes = Math.round(ms / 60000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : minutes
      ? `${minutes}m`
      : `${Math.round(ms / 1000)}s`;
};

/**
 * @param {ReturnType<typeof analyze>} a
 * @param {{ title: string, generatedAt: string, settings: Record<string, unknown>, durations: { baseline?: number, typed?: number }, links: { baseline?: string, typed?: string } }} meta
 */
export function renderHtml(a, meta) {
  const runRow = (
    /** @type {string} */ label,
    /** @type {ReturnType<typeof statusCounts> | undefined} */ s,
    /** @type {number | undefined} */ ms,
    /** @type {string | undefined} */ link,
  ) =>
    s
      ? `<tr><th scope="row">${link ? `<a href="${esc(link)}">${esc(label)}</a>` : esc(label)}</th><td>${s.total}</td><td>${s.killed}</td><td>${s.timeout}</td><td>${s.survived}</td><td>${s.noCoverage}</td><td>${s.compileError}</td><td>${s.ignored}</td><td>${pct(s.score)}</td><td>${duration(ms)}</td></tr>`
      : '';

  const mutatorRows = a.perMutator
    .map(
      (m) =>
        `<tr class="${m.typed ? 'typed' : ''}"><th scope="row">${esc(m.name)}</th><td>${m.total}</td><td>${m.killed}</td><td>${m.timeout}</td><td>${m.survived}</td><td>${m.noCoverage}</td><td>${m.compileError}</td><td>${pct(m.score)}</td><td>${m.redundant ?? ''}</td><td>${m.typed ? pct(m.nonRedundantPct) : ''}</td></tr>`,
    )
    .join('\n');

  const survivorRows = (
    /** @type {ReturnType<typeof analyze>['otherSurvivors']} */ list,
    /** @type {boolean} */ triage,
  ) =>
    list
      .map(
        (
          m,
        ) => `<tr data-id="${esc(`${m.fileName}:${m.location.start.line}:${m.location.start.column} ${m.mutatorName} ${m.replacement}`)}">
  <td class="loc">${esc(m.fileName)}:${m.location.start.line}:${m.location.start.column}</td>
  <td>${esc(m.mutatorName)}</td>
  <td><code class="orig">${esc(m.original.trim())}</code><code class="repl">→ ${esc(m.replacement)}</code></td>
  ${triage ? `<td><select aria-label="Verdict"><option value="">–</option><option value="gap">Real test gap</option><option value="equivalent">Equivalent</option><option value="unspecified">Unspecified behaviour</option><option value="other">Other</option></select></td><td><input type="text" aria-label="Notes" placeholder="Notes"></td>` : ''}
</tr>`,
      )
      .join('\n');

  const c = a.consistency;
  const consistencyHtml = c
    ? `<p>${c.same} of ${c.same + c.changed.length + c.onlyInTyped.length} primitive mutants have the same status in both runs; ${c.changed.length} changed status, ${c.onlyInTyped.length} exist only in the type-aware run, ${c.onlyInBaseline.length} only in the baseline.</p>
${c.changed.length ? `<details><summary>Changed status (${c.changed.length})</summary><ul>${c.changed.map((x) => `<li><code>${esc(x.key)}</code>: ${esc(x.from)} → ${esc(x.to)}</li>`).join('')}</ul></details>` : ''}
${c.onlyInTyped.length + c.onlyInBaseline.length ? `<p class="warn">The primitive mutant sets differ, so the runs did not mutate the same code (different scope, source changes between runs, or different Stryker versions).</p>` : ''}`
    : '<p>No baseline report.</p>';

  const settingsRows = Object.entries(meta.settings)
    .map(
      ([k, v]) =>
        `<tr><th scope="row">${esc(k)}</th><td><code>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</code></td></tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title>
<style>
:root { --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6b6b66; --line: #e3e2de; --accent: #2f5fd0; --typed: #eef3ff; --warn: #9a5b00; --card: #ffffff; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #161615; --fg: #ecebe7; --muted: #9b9a94; --line: #34332f; --accent: #8aa9ff; --typed: #1d2433; --warn: #e3a64a; --card: #1e1e1c; } }
:root[data-theme="dark"] { --bg: #161615; --fg: #ecebe7; --muted: #9b9a94; --line: #34332f; --accent: #8aa9ff; --typed: #1d2433; --warn: #e3a64a; --card: #1e1e1c; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.6rem; margin: 0 0 4px; } h2 { font-size: 1.15rem; margin: 36px 0 8px; }
.muted { color: var(--muted); } .warn { color: var(--warn); }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 20px 0; }
.kpi { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.kpi b { display: block; font-size: 1.6rem; font-variant-numeric: tabular-nums; } .kpi span { color: var(--muted); font-size: .85rem; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { font-size: .8rem; color: var(--muted); font-weight: 600; }
tr.typed { background: var(--typed); }
code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
code.orig, code.repl { display: block; white-space: pre-wrap; word-break: break-word; } code.repl { color: var(--accent); }
td.loc { white-space: nowrap; font-size: .85rem; }
a { color: var(--accent); }
select, input, button { font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; }
details { margin: 8px 0; } li code { word-break: break-all; }
</style>
</head>
<body>
<main>
<h1>${esc(meta.title)}</h1>
<p class="muted">Generated ${esc(meta.generatedAt)}</p>
${a.bailSuspected ? '<p class="warn">Every killed primitive mutant is killed by exactly one test: bail was probably enabled, so the redundancy numbers are unreliable.</p>' : ''}

<div class="kpis">
  <div class="kpi"><b>${a.typedOnly.total}</b><span>type-aware mutants${a.typedRunPrimitive.total ? ` (+${pct((100 * a.typedOnly.total) / a.typedRunPrimitive.total)} over primitive)` : ''}</span></div>
  <div class="kpi"><b>${a.survivorsWherePrimitivesDie.length}</b><span>typed survivors where all overlapping primitive mutants are detected</span></div>
  <div class="kpi"><b>${a.typedOnly.survived}</b><span>typed survivors in total</span></div>
  <div class="kpi"><b>${a.killedTyped ? pct((100 * (a.killedTyped - a.redundantTotal)) / a.killedTyped) : '–'}</b><span>of killed typed mutants not subsumed by a primitive mutant</span></div>
  <div class="kpi"><b>${a.typedOnly.compileError}</b><span>typed mutants with a compile error</span></div>
</div>

<h2>Runs</h2>
<div class="scroll"><table>
<thead><tr><th>Run</th><th>Total</th><th>Killed</th><th>Timeout</th><th>Survived</th><th>No coverage</th><th>Compile error</th><th>Ignored</th><th>Score</th><th>Duration</th></tr></thead>
<tbody>
${runRow('Baseline', a.baseline, meta.durations.baseline, meta.links.baseline)}
${runRow('Type-aware run (all)', a.typedRun, meta.durations.typed, meta.links.typed)}
${runRow('… primitive mutants', a.typedRunPrimitive, undefined, undefined)}
${runRow('… type-aware mutants', a.typedOnly, undefined, undefined)}
</tbody></table></div>

<h2>Primitive mutants: baseline vs type-aware run</h2>
${consistencyHtml}

<h2>Per mutator (type-aware run)</h2>
<p class="muted">Score = detected / (detected + undetected); compile errors and ignored mutants are excluded. Redundant = killed typed mutants for which a killed primitive mutant exists whose killing tests are a subset of theirs.</p>
<div class="scroll"><table>
<thead><tr><th>Mutator</th><th>Total</th><th>Killed</th><th>Timeout</th><th>Survived</th><th>No coverage</th><th>Compile error</th><th>Score</th><th>Redundant</th><th>Not redundant</th></tr></thead>
<tbody>
${mutatorRows}
</tbody></table></div>

<h2>Typed survivors where all overlapping primitive mutants are detected (${a.survivorsWherePrimitivesDie.length})</h2>
<p class="muted">The tests look complete to the primitive mutators here, but don't detect this type-correct change. Triage each one; your verdicts are kept in this browser and can be exported.</p>
<p><button id="export" type="button">Export verdicts (JSON)</button> <span id="tally" class="muted"></span></p>
<div class="scroll"><table id="triage">
<thead><tr><th>Location</th><th>Mutator</th><th>Original line → replacement</th><th>Verdict</th><th>Notes</th></tr></thead>
<tbody>
${survivorRows(a.survivorsWherePrimitivesDie, true)}
</tbody></table></div>

<h2>Other typed survivors (${a.otherSurvivors.length})</h2>
<p class="muted">Typed survivors next to a surviving primitive mutant: the tests are already known to be weak here.</p>
<div class="scroll"><table>
<thead><tr><th>Location</th><th>Mutator</th><th>Original line → replacement</th></tr></thead>
<tbody>
${survivorRows(a.otherSurvivors, false)}
</tbody></table></div>

<h2>Settings</h2>
<div class="scroll"><table><tbody>
${settingsRows}
</tbody></table></div>
</main>
<script>
(() => {
  const storageKey = ${JSON.stringify(`typed-benchmark:${meta.title}`)};
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch {}
  const rows = [...document.querySelectorAll('#triage tbody tr')];
  const tally = () => {
    const counts = {};
    for (const row of rows) { const v = row.querySelector('select').value; if (v) counts[v] = (counts[v] || 0) + 1; }
    document.getElementById('tally').textContent = Object.entries(counts).map(([k, n]) => k + ': ' + n).join(' · ');
  };
  const save = () => {
    const data = {};
    for (const row of rows) {
      const verdict = row.querySelector('select').value, notes = row.querySelector('input').value;
      if (verdict || notes) data[row.dataset.id] = { verdict, notes };
    }
    saved = data;
    try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch {}
    tally();
  };
  for (const row of rows) {
    const entry = saved[row.dataset.id];
    if (entry) { row.querySelector('select').value = entry.verdict; row.querySelector('input').value = entry.notes; }
    row.querySelector('select').addEventListener('change', save);
    row.querySelector('input').addEventListener('input', save);
  }
  tally();
  document.getElementById('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'typed-benchmark-verdicts.json';
    a.click();
  });
})();
</script>
</body>
</html>
`;
}
