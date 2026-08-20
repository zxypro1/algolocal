# Tests

Four suites live here. Three of them cover the code paths the app uses today; the fourth predates the move to in-browser execution and is kept for reference.

| Suite | Command | What it covers |
| --- | --- | --- |
| `tests/engineering` | `npm run test:engineering` | Virtual clock, lab sandbox, module runtime, spec framework, metric gates, scoring, and every preset project stage in both languages |
| `tests/ai` | `npm run test:ai` | Provider selection and model capabilities, the SSE streaming protocol, JSON extraction from model replies |
| `tests/editor` | `npm run test:editor` | Per-problem, per-language draft persistence |
| `tests/api` | `npm run test:api` | The old server-side runner (see below) |

## Engineering runtime

The interesting cases are the ones that catch a whole class of silent breakage:

The virtual clock has to tell serial and parallel apart. A test runs the same workload both ways and asserts the virtual elapsed time differs by the expected factor, which is the property the latency gates depend on.

Every preset stage is executed twice: once with its reference implementation, which must pass every spec and every gate, and once with the bare skeleton, which must fail. A stage whose skeleton also passes has specs with no discriminating power, and the suite rejects it. Eleven stages in two languages means 22 runs.

The rest are regressions, each tied to a bug that shipped: counters that read as NaN instead of zero, `deepEqual` treating any two Dates as equal, a throwing timer callback escaping as an uncaught global error, `afterAll` running after the first case instead of the last, an untouched workspace scoring 75 out of 100.

## API suite

`tests/api` targets `pages/api/run.ts`, an endpoint that no longer exists. Code now runs in the browser through WASM, and only JavaScript, TypeScript and Python are supported; the Java, C++ and C paths these tests exercise were removed with the endpoint. The files are still here because parts of them (problem data validation in `problem-data.test.js`) are worth salvaging, but the suite as a whole fails and `npm test` fails with it.

## Running them

```bash
npm run test:engineering
npm run test:ai
npm run test:editor

# Everything, including the stale API suite
npm test
```

Jest runs in the Node environment with a 30 second timeout and a single worker, since several tests execute generated code. `jest.setup.js` extends the timeout further and quiets console output.

## Adding a test

Put it next to the code it covers: runtime behaviour in `tests/engineering`, anything touching a provider or the streaming protocol in `tests/ai`, editor state in `tests/editor`.

Write the failing case first and confirm it fails for the reason you think. A test that passes against the broken version is worse than no test, and this suite has had at least one of those: a spec asserting `clearTimeout` was called, which the sandbox cannot observe, so it passed either way. It was replaced with an honest assertion and the point moved into a pitfall.

Name the case after the behaviour rather than the function. `treats an empty draft as no draft` says what breaks if it fails; `test draft loading` does not.
