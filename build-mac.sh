#!/bin/bash

echo "=========================================="
echo "Building Algorithm Practice for macOS"
echo "WASM-based code execution (Browser-side)"
echo "=========================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "✗ Error: Node.js not found"
    echo "Please install Node.js: https://nodejs.org"
    exit 1
fi

echo "✓ Node.js installed: $(node --version)"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "✗ Error: npm not found"
    echo "Please install npm"
    exit 1
fi

echo "✓ npm installed: $(npm --version)"

# Clean previous builds
echo ""
echo "Cleaning previous builds..."
rm -rf dist .next

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "✗ Failed to install dependencies"
    exit 1
fi
echo "✓ Dependencies installed successfully"

# Build Next.js app
echo ""
echo "Building Next.js application..."
npm run build
if [ $? -ne 0 ]; then
    echo "✗ Next.js build failed"
    exit 1
fi
echo "✓ Next.js build completed successfully"

# Build Electron app for macOS
echo ""
echo "Building Electron app for macOS..."
echo "   Targets: DMG (x64, arm64), ZIP (x64, arm64)"
npx electron-builder --config electron-builder.config.js --mac
if [ $? -ne 0 ]; then
    echo "✗ Electron build failed"
    exit 1
fi

echo ""
echo "=========================================="
echo "✓ macOS build completed successfully!"
echo "=========================================="
echo ""
echo "Output files in 'dist' folder:"
ls -la dist/*.dmg dist/*.zip 2>/dev/null || echo "   Check dist folder for output files"
echo ""
