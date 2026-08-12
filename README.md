# AlgoLocal

[中文](./README-zh.md) | [Español](./README.es-ES.md)

Quick links: [Discussions](https://github.com/zxypro1/algolocal/discussions) | [Issues](https://github.com/zxypro1/algolocal/issues) | [Pull Requests](https://github.com/zxypro1/algolocal/pulls)

> Practice coding algorithms 100% offline with AI: generate problems, get hints, discuss solutions, and run code in JavaScript, TypeScript, or Python — no internet or setup required.

<img width="1909" height="930" alt="2026" src="https://github.com/user-attachments/assets/7292075e-6d1b-4fc3-9019-7a80f17c1711" />

<img width="1909" height="930" alt="2025-08-24165302" src="https://github.com/user-attachments/assets/93116550-60af-41aa-b0f3-cc2b10fd5ac5" />

## Quick Start

### Desktop Application (Recommended)

The desktop application provides the best experience with zero environment setup required. Simply download and run.

**[Download Latest Release](https://github.com/zxypro1/algolocal/releases/latest)**

| Platform | Download |
|----------|----------|
| **macOS** (Apple Silicon) | `AlgoLocal-*-macOS-arm64.dmg` |
| **macOS** (Intel) | `AlgoLocal-*-macOS-x64.dmg` |
| **Windows** (Installer) | `AlgoLocal-*-Windows-Setup.exe` |
| **Windows** (Portable) | `AlgoLocal-*-Windows-Portable.exe` |
| **Linux** (AppImage) | `AlgoLocal-*-Linux.AppImage` |
| **Linux** (Debian/Ubuntu) | `AlgoLocal-*-Linux.deb` |
| **Linux** (Fedora/RHEL) | `AlgoLocal-*-Linux.rpm` |

**macOS Users**: If you encounter "App is damaged and can't be opened", run in Terminal:
```bash
xattr -cr "/Applications/AlgoLocal.app"
```

### Web Version (Alternative)

For developers who prefer running from source, see [Development Setup](#development-setup) below.

## Features

### Core Functionality

- **AI-Powered Practice**: Generate problems, get hints, chat about solutions, and generate detailed explanations with multiple approaches — all powered by AI
- **Complete Offline Support**: Works 100% offline after initial setup, no internet required during practice
- **WASM Code Execution**: Browser-side execution for JavaScript, TypeScript, and Python
- **Monaco Code Editor**: VS Code-like editing experience with syntax highlighting and autocomplete
- **Practice Dashboard**: Track your progress with daily statistics, accuracy metrics, heatmap visualization, and performance trends
- **Built-in Problem Library**: 10+ classic algorithm problems included, easily expandable
- **Cross-platform**: Windows, macOS, and Linux supported

### Supported Languages

| Language | Status | Implementation |
|----------|--------|----------------|
| **JavaScript** | Supported | Native browser execution |
| **TypeScript** | Supported | TypeScript compiler transpilation |
| **Python** | Supported | Pyodide (CPython WASM) |

All code execution happens in the browser using WebAssembly. No server-side execution required.

### AI-Powered Features

The application includes three AI-powered tools that share the same provider configuration:

- **AI Problem Generator**: Describe what you want to practice in natural language, and AI creates a complete problem with test cases and reference solutions
- **AI Solution Generation**: Generate multiple solution approaches (brute force + optimized) with detailed annotations, complexity analysis, and trade-offs explained
- **AI Chat Assistant**: Get contextual hints while solving problems without spoiling the solution. Ask questions about your current code or approach
- **Flexible Configuration**: Switch between DeepSeek, OpenAI, Claude, Qwen, or local Ollama models anytime

## How to Use

### Problem Solving

1. **Browse Problems**: View the problem list with difficulty and tags
2. **Select a Problem**: Click on any problem to open the detail page
3. **Choose Language**: Select JavaScript, TypeScript, or Python
4. **Write Solution**: Use the Monaco editor with full IDE features
5. **Get AI Help** (Optional):
   - **AI Chat**: Ask for hints or discuss your approach without getting the full solution
   - **AI Solution**: Generate complete annotated solutions with multiple approaches
6. **Run Tests**: Click "Submit & Run Tests" to execute your code
7. **View Results**: See detailed test results with execution time
8. **Track Progress**: Check the Practice Dashboard to see your statistics and performance trends

### AI Problem Generation

1. **Access Generator**: Click "AI Generator" on the homepage
2. **Describe Requirements**: Enter what type of problem you want (e.g., "binary search tree", "dynamic programming")
3. **Generate**: AI creates a complete problem with test cases and solutions
4. **Practice**: Generated problem is automatically available in your library

### Practice Analytics

1. **Access Dashboard**: Click "Practice Stats" or "Dashboard" on the homepage
2. **View Statistics**: See your total problems attempted, solved, and accuracy rate
3. **Analyze Performance**: Review accuracy breakdown by difficulty level and problem tags
4. **Track Streaks**: Visualize your daily practice activity with an interactive heatmap
5. **Review History**: Check your recent attempts and identify areas for improvement

### Settings Configuration

Access the settings page to configure AI providers:

- **Desktop Mode**: Via "Settings" button or application menu
- **Web Mode**: Navigate to `/settings` (e.g., http://localhost:3000/settings)

Supported AI providers:
- DeepSeek
- OpenAI
- Qwen (Alibaba Cloud)
- Claude (Anthropic)
- Ollama (Local)

Configuration is saved to `~/.offline-leet-practice/config.json` in desktop mode. See [AI_PROVIDER_GUIDE.md](./AI_PROVIDER_GUIDE.md) for detailed configuration.

### Adding Custom Problems

1. **Via UI**: Use the "Add Problem" page in the application
2. **JSON Import**: Upload or paste problem data in JSON format
3. **Direct Edit**: Modify `public/problems.json` for immediate changes

See [MODIFY-PROBLEMS-GUIDE.md](./MODIFY-PROBLEMS-GUIDE.md) for the complete guide.

## Development Setup

For developers who want to run from source or contribute to the project.

### Prerequisites

- Node.js 18+ ([Download](https://nodejs.org/))
- npm 8+

### Running Locally

**Windows:**
```bash
start-local.bat
```

**macOS / Linux:**
```bash
chmod +x start-local.sh
./start-local.sh
```

**Manual Setup:**
```bash
git clone https://github.com/zxypro1/algolocal.git
cd algolocal
npm install
npm run build
npm start
```

Then open http://localhost:3000 in your browser.

### Building Desktop Application

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

See [DESKTOP-APP-GUIDE.md](./DESKTOP-APP-GUIDE.md) for detailed build instructions.

## Technology Stack

- **Frontend**: React 18, Next.js 13, TypeScript
- **UI Framework**: Mantine v7
- **Code Editor**: Monaco Editor
- **Code Execution**: WebAssembly
  - JavaScript: Native browser `Function` constructor
  - TypeScript: TypeScript compiler (CDN)
  - Python: Pyodide (CPython compiled to WASM)
- **Desktop**: Electron

## Project Structure

```
OfflineLeetPractice/
├── pages/                  # Next.js pages and API routes
│   ├── api/
│   │   ├── problems.ts     # Problem data API
│   │   ├── generate-problem.ts  # AI problem generation
│   │   ├── ai-solution.ts  # AI solution generation
│   │   ├── ai-chat.ts      # AI chat assistant
│   │   ├── add-problem.ts
│   │   └── ...
│   ├── problems/[id].tsx   # Problem detail page (with AI chat + AI solution)
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
│   │   └── useWasmExecutor.ts
│   └── lib/
│       └── practiceStats.ts  # Local statistics tracking
├── public/
│   └── problems.json       # Problem database
├── electron-main.js        # Electron main process
└── electron-builder.config.js
```

## Contributing

Contributions are welcome. Areas for improvement:

- Additional algorithm problems
- Performance analytics features
- User experience enhancements
- Documentation improvements

## License

MIT License

---

**Practice algorithms anywhere — on flights, cruises, or any offline environment.**
