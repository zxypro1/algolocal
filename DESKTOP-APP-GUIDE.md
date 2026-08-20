# Desktop Application Build Guide

This guide covers building AlgoLocal as a cross-platform desktop application for Windows, macOS, and Linux.

## What gets built

A self-contained package. Whoever downloads it does not need Node.js, Python or any development tools installed.

Inside it is the Next.js and React app running in Electron. Code executes in the browser layer through WebAssembly: JavaScript natively, TypeScript transpiled by the TypeScript compiler first, Python on Pyodide.

## What you need to build it

Only for building from source:

- Node.js >= 18.x
- npm >= 8.x
- Platform-specific requirements:
  - macOS builds: macOS system
  - Windows builds: Windows system or Wine
  - Linux builds: Linux system or Docker

## Building the Application

### Development Mode

```bash
npm install
npm run build
npm run electron:start
```

### Production Builds

#### macOS

```bash
./build-mac.sh
# or
npm run dist:mac
```

Output:
- `dist/AlgoLocal-x.x.x-macOS-x64.dmg` (Intel)
- `dist/AlgoLocal-x.x.x-macOS-arm64.dmg` (Apple Silicon)

#### Windows

PowerShell:
```powershell
.\build-windows.ps1
# or
npm run dist:win
```

Command Prompt:
```cmd
build-windows.bat
```

Output:
- `dist/AlgoLocal-x.x.x-Windows-x64.exe` (Installer)
- `dist/AlgoLocal-x.x.x-Windows-Portable.exe` (Portable)

#### Linux

```bash
npm run dist:linux
```

Output:
- `dist/AlgoLocal-x.x.x-Linux.AppImage`
- `dist/AlgoLocal-x.x.x-Linux.deb`
- `dist/AlgoLocal-x.x.x-Linux.rpm`

#### All Platforms

```bash
npm run dist:all
```

## Supported Languages

| Language | Status | Implementation |
|----------|--------|----------------|
| JavaScript | Supported | Native browser |
| TypeScript | Supported | TypeScript compiler |
| Python | Supported | Pyodide (WASM) |

Note: Languages requiring native compilers (Java, C, C++, Go) are not supported in the browser-side WASM environment.

## Project Structure

```
.
├── electron-main.js          # Electron main process
├── electron-preload.js       # Electron preload script
├── electron-builder.config.js # Build configuration
├── build/
│   └── entitlements.mac.plist # macOS entitlements
├── build-mac.sh              # macOS build script
├── build-windows.ps1         # Windows PowerShell build script
├── build-windows.bat         # Windows batch build script
└── dist/                     # Build output directory
```

## Configuration

### electron-builder.config.js

Key configuration options:

- `appId`: Application identifier
- `productName`: Application display name
- `files`: Files to include in package
- `win/mac/linux`: Platform-specific configurations

### AI Provider Settings

The desktop application supports configuration through the built-in settings page:

- DeepSeek
- OpenAI
- Qwen (Alibaba Cloud)
- Claude (Anthropic)
- Ollama (Local)

Configuration is stored in `~/.offline-leet-practice/config.json`.

## Troubleshooting

### macOS: Security Warning

When first opening the application, macOS may display a security warning.

Solution:
1. Open System Preferences > Security & Privacy
2. Click "Open Anyway"

Or run in Terminal:
```bash
xattr -cr "/Applications/AlgoLocal.app"
```

### Windows: SmartScreen Warning

Windows may display a SmartScreen warning for unsigned applications.

Solution: Click "More info" > "Run anyway"

### Code Signing

For production distribution, code signing is recommended:

macOS needs an Apple Developer certificate, Windows an EV code signing certificate.

## Changelog

### v0.0.9
- Migrated to pure WASM browser-side code execution
- Added TypeScript support
- Removed dependency on server-side execution
- Improved Electron build configuration
- Enhanced settings page for AI provider configuration

## License

MIT License
