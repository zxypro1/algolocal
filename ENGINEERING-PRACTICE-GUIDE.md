# Engineering Practice Guide / 工程实战指南

> How the Engineering Practice module works, and how to author your own projects.
>
> 工程实战模块的工作原理，以及如何自己编写工程题。

---

## Why this module exists

The algorithm side of AlgoLocal answers one question: is your function correct? Engineering asks
harder ones:

- Does it stay correct under concurrency?
- Does it hold a latency budget when the dependency is slow?
- Does it behave sanely when the dependency is down?
- Can someone else read, test and extend it six months from now?

A project here is a small system you build across several stages in a real multi-file workspace.
Every stage is judged by hidden acceptance specs and by engineering gates on measured metrics.

算法题只回答「函数对不对」；工程题还要回答「并发下对不对、慢了会怎样、挂了会怎样、别人能不能维护」。
所以工程实战的评审维度是：正确性、并发度、延迟、容错性、封装、优雅程度。

---

## The three pieces

### 1. A multi-file workspace

Each project ships a file tree: read-only contract files (types the platform will check against) plus
starter files with signatures and `TODO`. Later stages unlock more files.

Your edits are saved to `localStorage` per project, so closing the tab does not lose them.

### 2. A virtual clock

Everything runs on a virtual clock. `sleep(200)` does not wait 200ms; it moves a deterministic
timeline forward. That means:

- 200 requests of 100ms finish instantly in real time, but
- the difference between serial (20 000ms) and 4-way parallel (5 000ms) is measured exactly, and
- results are reproducible: the same code always produces the same numbers.

Inside the sandbox, `setTimeout`, `setInterval`, `Date.now()` and `performance.now()` are all wired to
the virtual clock, so ordinary async code just works.

### 3. Measured gates

A stage can require, for example, "peak concurrency ≤ 4", "12 requests within 300ms", "the downstream
receives zero traffic once the breaker opens". Those are asserted against real measurements from the
run, not from reading your code.

---

## Platform modules available in the workspace

```ts
import { request } from '@lab/net';       // simulated downstream: measures concurrency, latency, retries, duplicates
import { sleep, now, random } from '@lab/env';   // virtual clock + reproducible randomness
import { count, getCounters } from '@lab/metrics'; // your own counters
```

`request(url, options?)` resolves to `{ status, data, url }` and rejects with a `LabHttpError`
carrying `status` and `url`. There is no filesystem, no real network, no npm packages and no DOM:
only your own files and these modules.

---

## Metrics the platform records

| Path | Meaning |
| --- | --- |
| `virtualElapsedMs` | Virtual wall time of the scenario (your latency) |
| `maxConcurrency` | Peak simultaneous in-flight requests |
| `requests.total` / `.ok` / `.failed` | Downstream call volume |
| `requests.throttled` | Calls rejected with 429 for exceeding the server's concurrency limit |
| `requests.retries` | Repeat calls to a url whose previous attempt failed |
| `requests.duplicated` | Repeat calls to a url whose previous attempt already succeeded (a missing cache or dedup) |
| `counters.<name>` | Whatever you emit through `count()` |

---

## Scoring

Two independent sources are combined. The measured half is the spec pass rate plus the metric gates,
mapped onto the concurrency, latency and resilience dimensions; a gate you miss still earns partial
credit based on how close you got. The static half comes from reading the code: function length,
cyclomatic complexity, duplicated blocks, magic numbers, module fan-out, dependency cycles and export
surface feed the encapsulation and elegance dimensions.

On top of that, AI review reads the actual code, the latest run and the static metrics, and reviews it
like a pull request for a production service: concurrency safety first, then latency behaviour, failure
behaviour, module boundaries and last of all style. The prompt tells it explicitly that a green test
suite does not mean the design is good.

Everything runs locally except the AI calls, which use whichever provider you configured in Settings.

---

## Authoring your own project

Projects are authored as JavaScript modules under `projects/definitions/` and compiled into
`projects/projects.json`:

```bash
npm run projects:build     # definitions -> projects/projects.json + public/projects.json
npm run projects:verify    # build, then execute every stage against its reference solution
```

`_helpers.js` gives you `t()` for bilingual text, `code` for indentation-stripped code blocks, and
`file` / `readonlyFile` / `spec` / `gate` builders.

> Code snippets use `String.raw`, so do not use `${}` template literals inside authored code.
> Use string concatenation instead.

### The shape of a stage

```js
{
  id: 'concurrency-pool',
  title: t('第 2 关 · 有上限的并发', 'Stage 2 · Bounded concurrency'),
  goal: t('markdown: what to build, the exact API contract, why it matters', '…'),
  checklist: [t('…', '…')],
  pitfalls: [t('wrong approach + why it fails in production', '…')],  // always visible
  hints: [t('…', '…')],              // revealed one at a time by the learner
  extension: t('markdown: the real-world counterpart', '…'),          // collapsible
  starterFiles: [file('src/pool.ts', code`…signatures + TODO…`)],
  specs: [spec('specs/stage-2.spec.ts', code`…hidden tests…`)],
  gates: [gate({ metric: 'maxConcurrency', op: 'lte', value: 4,
                 zh: '峰值并发 ≤ 4', en: 'Peak concurrency ≤ 4',
                 dimension: 'concurrency', scope: 'gate:concurrency' })],
  lab: { defaultLatencyMs: 100, serverConcurrencyLimit: 5 },
  referenceFiles: [file('src/pool.ts', code`…complete working solution…`)],
  referenceNotes: t('why this design', '…'),
}
```

At the project level you can also set `learningOutcomes` and `prerequisites` (both arrays of
bilingual text); they render above the brief.

### How much content a stage needs

The preset projects average nine spec cases and four pitfalls per stage, which is roughly the floor
for a stage to teach anything.

Specs should cover the happy path and the edges: empty input, single element, a limit larger than the
workload, boundary values, error propagation, and at least one case that catches the
plausible-but-wrong implementation (for example, peak concurrency has to be exactly 4, not lower).

A pitfall is a wrong approach plus why it fails, not a restatement of the requirement. "Remember to
await" teaches nothing. "Forgetting `await next()` makes the timing middleware report 0ms and lets
downstream errors escape your catch" describes a bug someone will actually write.

The extension section is what connects a stage to production: name the library that does this for real
(`p-limit`, `errgroup.SetLimit`, Guava `RateLimiter`, `singleflight`), the failure mode that has a name
(stampede, thundering herd, retry amplification), or the constraint that changes at scale.

Some properties are not observable from spec-land at all. A leaked `setTimeout` is invisible in this
sandbox, so say that in a pitfall rather than writing a spec that appears to check it and does not.

### Rules

- Stages are cumulative: stage N's workspace is the base files plus the starter files of stages 1..N,
  with the learner's own code from earlier stages carried forward.
- Every stage needs `referenceFiles`, a complete working solution. `npm run projects:verify` executes
  it, and the stage is not valid until it passes its own specs and gates.
- Starter files have to fail. The verifier also runs the bare skeleton; if the specs still pass, the
  stage is rejected for having no discriminating power.
- Scope your gates. A gate without `scope` is evaluated against the aggregate metrics of the whole run,
  so a test that deliberately demonstrates the slow path will fail your own latency gate. Tag such
  tests (`it('… [gate:latency]')`) and set `scope: 'gate:latency'`.
- Compute the latency numbers instead of guessing. With `defaultLatencyMs: 100`, 12 urls at concurrency
  4 take exactly 300ms, and the specs assert exact values, so the arithmetic has to be right.

### Spec files

Specs use a built-in mini framework, `describe`, `it`, `expect`, `beforeEach`, `afterEach` are globals,
do not import them. Matchers: `toBe`, `toEqual`, `toBeTruthy`, `toBeFalsy`, `toBeNull`, `toBeUndefined`,
`toBeDefined`, `toBeInstanceOf`, `toBeGreaterThan(OrEqual)`, `toBeLessThan(OrEqual)`, `toBeCloseTo`,
`toContain`, `toHaveLength`, `toHaveProperty`, `toMatch`, `toThrow`, `.not`, and for async:

```ts
await expect(async () => doThing()).rejects.toThrow('message');
```

Each test case gets a fresh lab (clock and metrics reset), while modules stay loaded for the whole
spec file, which is why preset projects export factories (`createPipeline`) rather than singletons.

---

## AI-generated projects

`/projects/generator` asks a model for a whole project, then runs it before accepting it:

1. Generate JSON → structural validation.
2. Execute every stage with its reference solution; execute the starter skeleton too.
3. Feed any failure (a spec that doesn't pass, a gate whose arithmetic is wrong, a skeleton that
   passes anyway) back to the model for one repair round.
4. Only a project that survives that is saved automatically. Otherwise you see exactly what failed and
   can regenerate or save it anyway.

Generated projects live in `~/.offline-leet-practice/user-projects.json`, so upgrading the app never
overwrites them, and packaged desktop builds can still write them.

---

## Where things live

| Path | What |
| --- | --- |
| `src/lib/engineering/clock.ts` | Virtual clock + the driver loop |
| `src/lib/engineering/lab.ts` | Simulated downstream, metrics, sandbox globals |
| `src/lib/engineering/moduleRuntime.ts` | Multi-file CommonJS resolver |
| `src/lib/engineering/specRunner.ts` | describe / it / expect |
| `src/lib/engineering/runner.ts` | Runs a stage, aggregates metrics, evaluates gates |
| `src/lib/engineering/analysis.ts` | Static code-quality heuristics |
| `src/lib/engineering/scoring.ts` | Dimension scores |
| `src/workers/projectRunner.worker.ts` | Runs everything off the main thread |
| `projects/definitions/` | Preset project sources |
| `pages/projects/` | List, workspace and generator pages |
| `tests/engineering/runtime.test.ts` | Regression tests, incl. every preset stage |

An infinite loop in workspace code only kills the worker: the run times out after 30s, your files are
already saved, and the page stays responsive.
