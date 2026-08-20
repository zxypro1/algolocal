# AlgoLocal

[中文](./README-zh.md) | [Español](./README.es-ES.md)

Quick links: [Discussions](https://github.com/zxypro1/algolocal/discussions) | [Issues](https://github.com/zxypro1/algolocal/issues) | [Pull Requests](https://github.com/zxypro1/algolocal/pulls)

> Practice coding algorithms 100% offline with AI: generate problems, get hints, discuss solutions, and run code in JavaScript, TypeScript, or Python, no internet or setup required.

<img alt="Solving an algorithm problem, tests running in the browser" src="./docs/screenshots/practice-en.png" />

<img alt="Engineering Practice: a multi-file workspace with hidden specs and engineering gates" src="./docs/screenshots/engineering-en.png" />

## Quick start

### Desktop app

Nothing to install or configure. Download it and run it.

[Download the latest release](https://github.com/zxypro1/algolocal/releases/latest)

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | `AlgoLocal-*-macOS-arm64.dmg` |
| macOS (Intel) | `AlgoLocal-*-macOS-x64.dmg` |
| Windows (Installer) | `AlgoLocal-*-Windows-Setup.exe` |
| Windows (Portable) | `AlgoLocal-*-Windows-Portable.exe` |
| Linux (AppImage) | `AlgoLocal-*-Linux.AppImage` |
| Linux (Debian/Ubuntu) | `AlgoLocal-*-Linux.deb` |
| Linux (Fedora/RHEL) | `AlgoLocal-*-Linux.rpm` |

If macOS says the app is damaged and cannot be opened, clear the quarantine attribute:
```bash
xattr -cr "/Applications/AlgoLocal.app"
```

### From source

See [running locally](#running-locally) below.

## Features

Two ways to practise. Algorithm problems are the familiar kind: read the statement, write a function, run the tests. Engineering Practice is the other half, described below, where you build a small multi-file system across several stages and get judged on concurrency, latency, resilience and how the code reads.

Everything runs on your machine. After the first setup the app needs no internet, code executes in the browser through WebAssembly, and your attempts stay in local storage rather than on someone's server. AI help is there when you want it and idle when you don't.

The editor is Monaco, the same one VS Code uses, with syntax highlighting, autocomplete and your drafts saved per problem and per language. The dashboard tracks what you solved and when, with accuracy by difficulty and tag, a heatmap of daily activity, and your recent attempts. 29 problems ship with the app and you can add your own.

Windows, macOS and Linux are all supported.

### Languages

| Language | How it runs |
|----------|-------------|
| JavaScript | Natively in the browser |
| TypeScript | Transpiled by the TypeScript compiler, then run |
| Python | Pyodide, CPython compiled to WebAssembly |

No server-side execution is involved.

### What the AI does

Four features share one provider configuration, so you set your key once.

The problem generator takes a description in plain language and writes a complete problem: statement, test cases including edge cases, starter templates and a reference solution. The solution generator produces several approaches for a problem you are stuck on, brute force through optimised, each annotated with its complexity and the trade-off it makes. The chat assistant answers questions about the code you have written without handing you the answer, and the engineering review comments on a finished stage the way a reviewer would on a production pull request.

Bring DeepSeek, OpenAI, Claude, Qwen, or a local Ollama model, and switch between them whenever you like. See [AI_PROVIDER_GUIDE.md](./AI_PROVIDER_GUIDE.md).

## Engineering practice

Algorithm problems ask whether your function is correct. Engineering Practice asks the questions that
decide whether code ships: does it stay correct under concurrency, does it hold a latency budget, what
happens when the dependency is down, and can someone else maintain it.

A project is a small system you build across several stages in a real multi-file workspace:

- A file tree, tabbed Monaco editor, read-only contract files, and files that unlock as you go
- Each stage adds one engineering concern, then unlocks the next
- Hidden acceptance specs, plus engineering gates on measured metrics ("peak concurrency ≤ 4", "12 requests within 300ms")
- A virtual clock, so `sleep(200)` costs no real time while latency and concurrency are still measured exactly
- Scoring across correctness, concurrency, latency, resilience, encapsulation and elegance
- AI review that reads your code, the latest run and the static metrics, then reviews it like a production pull request
- AI generation: describe what you want to practise, and the generated project gets executed against its own reference solution before it is accepted

Three projects ship built in: a resilient fetch pipeline (bounded concurrency, backoff, single-flight,
cancellation), an event-driven order pipeline (event bus, onion middleware, idempotency, DLQ), and a
resilient API gateway (token bucket, circuit breaker, timeout budgets).

See the [Engineering Practice Guide](./ENGINEERING-PRACTICE-GUIDE.md) to author your own.

## Using it

Pick a problem from the list, choose a language, and write your solution in the editor. "Submit & Run Tests" runs it in the browser and shows each case with its execution time. If you get stuck, the AI chat gives hints about your actual code, and the AI solution generator writes out several approaches once you want to see them. Your progress shows up in the dashboard.

For Engineering Practice, open a project, read the stage brief on the left, write code in the workspace, and click "Run acceptance". You get the spec results, the measured metrics, the engineering gates, a score across the six dimensions, and an AI review if you ask for one. Clear a stage and the next one unlocks.

To generate a problem, open the AI Generator and describe what you want to practise, for example "binary search tree" or "dynamic programming with an optimal substructure". The generated problem lands in your library.

Settings is where the AI providers live: the Settings button or application menu in the desktop app, `/settings` in the browser. Desktop configuration is written to `~/.offline-leet-practice/config.json`.

You can add problems through the "Add Problem" page, by pasting or uploading JSON, or by editing `public/problems.json` directly. [MODIFY-PROBLEMS-GUIDE.md](./MODIFY-PROBLEMS-GUIDE.md) covers the format.

## Running locally

You need Node.js 18 or newer ([download](https://nodejs.org/)) and npm 8 or newer.

Windows:
```bash
start-local.bat
```

macOS and Linux:
```bash
chmod +x start-local.sh
./start-local.sh
```

Or do it by hand:
```bash
git clone https://github.com/zxypro1/algolocal.git
cd algolocal
npm install
npm run build
npm start
```

Then open http://localhost:3000 in your browser.

### Building the desktop app

```bash
# macOS
npm run dist:mac

# Windows
npm run dist:win

# Linux
npm run dist:linux

# All platforms
npm run dist:all
```

[DESKTOP-APP-GUIDE.md](./DESKTOP-APP-GUIDE.md) has the details.

## Built with

React 18 and Next.js 13 in TypeScript, Mantine v7 for the interface, Monaco for the editor, and Electron for the desktop builds. Code execution is WebAssembly: JavaScript runs through the browser's `Function` constructor, TypeScript is transpiled by the TypeScript compiler first, and Python runs on Pyodide.

## Project structure

```
algolocal/
├── pages/                  # Next.js pages and API routes
│   ├── api/
│   │   ├── problems.ts     # Problem data API
│   │   ├── generate-problem.ts  # AI problem generation
│   │   ├── ai-solution.ts  # AI solution generation
│   │   ├── ai-chat.ts      # AI chat assistant
│   │   ├── add-problem.ts
│   │   └── ...
│   ├── problems/[id].tsx   # Problem detail page (with AI chat + AI solution)
│   ├── projects/           # Engineering Practice: list, workspace, generator
│   ├── generator.tsx       # AI Generator page
│   ├── stats.tsx           # Practice Dashboard page
│   ├── manage.tsx          # Problem management page
│   └── index.tsx           # Homepage
├── src/
│   ├── components/         # React components
│   │   ├── PracticeDashboard.tsx  # Stats visualization
│   │   ├── ContributionHeatmap.tsx
│   │   └── ...
│   ├── hooks/
│   │   ├── useWasmExecutor.ts
│   │   └── useProjectRunner.ts   # Runs a stage in a Web Worker
│   ├── lib/
│   │   ├── practiceStats.ts  # Local statistics tracking
│   │   └── engineering/      # Virtual clock, lab, module runtime, spec runner, scoring
│   └── workers/
│       └── projectRunner.worker.ts
├── projects/
│   ├── definitions/        # Engineering project sources (compiled to projects.json)
│   └── projects.json
├── public/
│   ├── problems.json       # Problem database
│   └── projects.json       # Engineering project database
├── electron-main.js        # Electron main process
└── electron-builder.config.js
```

## Contributing

Contributions are welcome. More algorithm problems and more engineering projects are the most useful thing to add; fixes to the analytics, the interface and these docs are equally welcome.

## License

MIT License

---

Practise anywhere: on a plane, on a boat, or anywhere else without a connection.
