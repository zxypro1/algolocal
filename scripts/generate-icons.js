#!/usr/bin/env node
/**
 * Icon Generator Script
 * 
 * 生成 Electron 应用所需的各种图标格式
 * 
 * 依赖：需要安装 sharp 和 png-to-ico
 * npm install sharp png-to-ico --save-dev
 * 
 * 使用方法：
 * node scripts/generate-icons.js
 */

const fs = require('fs');
const path = require('path');

async function generateIcons() {
  let sharp;
  let pngToIco;
  
  try {
    sharp = require('sharp');
  } catch (e) {
    console.log('Installing sharp for image processing...');
    const { execSync } = require('child_process');
    execSync('npm install sharp --save-dev', { stdio: 'inherit' });
    sharp = require('sharp');
  }

  try {
    pngToIco = require('png-to-ico');
  } catch (e) {
    console.log('Installing png-to-ico for Windows icon generation...');
    const { execSync } = require('child_process');
    execSync('npm install png-to-ico --save-dev', { stdio: 'inherit' });
    pngToIco = require('png-to-ico');
  }

  const svgPath = path.join(__dirname, '../public/favicon.svg');
  const buildDir = path.join(__dirname, '../build');
  const publicDir = path.join(__dirname, '../public');

  // Ensure build directory exists
  if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
  }

  // Create icons subdirectory
  const iconsDir = path.join(buildDir, 'icons');
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }

  const svgBuffer = fs.readFileSync(svgPath);

  // Icon sizes needed for different platforms
  const sizes = {
    // macOS
    mac: [16, 32, 64, 128, 256, 512, 1024],
    // Windows (for .ico file)
    win: [16, 24, 32, 48, 64, 128, 256],
    // Linux
    linux: [16, 24, 32, 48, 64, 128, 256, 512]
  };

  console.log('Generating application icons...\n');

  try {
    // Generate main icon.png (512x512)
    console.log('Creating main icon (512x512)...');
    await sharp(svgBuffer)
      .resize(512, 512)
      .png()
      .toFile(path.join(publicDir, 'icon.png'));
    console.log('   ✓ public/icon.png');

    // Generate 256x256 PNG for Windows ICO conversion
    const icon256Path = path.join(buildDir, 'icon-256.png');
    await sharp(svgBuffer)
      .resize(256, 256)
      .png()
      .toFile(icon256Path);
    
    // Generate Windows .ico file
    console.log('\nCreating Windows .ico file...');
    const icoBuffer = await pngToIco([icon256Path]);
    fs.writeFileSync(path.join(buildDir, 'icon.ico'), icoBuffer);
    console.log('   ✓ build/icon.ico');

    // Generate macOS icons
    console.log('\nCreating macOS icons...');
    for (const size of sizes.mac) {
      const filename = `icon_${size}x${size}.png`;
      await sharp(svgBuffer)
        .resize(size, size)
        .png()
        .toFile(path.join(iconsDir, filename));
      console.log(`   ✓ ${filename}`);
    }

    // Generate @2x versions for macOS
    for (const size of [16, 32, 128, 256, 512]) {
      const filename = `icon_${size}x${size}@2x.png`;
      await sharp(svgBuffer)
        .resize(size * 2, size * 2)
        .png()
        .toFile(path.join(iconsDir, filename));
      console.log(`   ✓ ${filename}`);
    }

    // Generate Windows icon sizes (individual PNGs)
    console.log('\nCreating Windows PNG icons...');
    for (const size of sizes.win) {
      const filename = `icon_${size}.png`;
      await sharp(svgBuffer)
        .resize(size, size)
        .png()
        .toFile(path.join(iconsDir, filename));
      console.log(`   ✓ ${filename}`);
    }

    // Generate favicon.ico (multi-size) - simplified version
    console.log('\nCreating favicon...');
    await sharp(svgBuffer)
      .resize(32, 32)
      .png()
      .toFile(path.join(publicDir, 'favicon-32.png'));
    console.log('   ✓ favicon-32.png');

    await sharp(svgBuffer)
      .resize(16, 16)
      .png()
      .toFile(path.join(publicDir, 'favicon-16.png'));
    console.log('   ✓ favicon-16.png');

    // Linux icons
    console.log('\nCreating Linux icons...');
    for (const size of sizes.linux) {
      const filename = `${size}x${size}.png`;
      await sharp(svgBuffer)
        .resize(size, size)
        .png()
        .toFile(path.join(iconsDir, filename));
      console.log(`   ✓ ${filename}`);
    }

    // Cleanup temporary file
    fs.unlinkSync(icon256Path);

    console.log('\nIcon generation complete!');
    console.log('\nGenerated files:');
    console.log('   - public/icon.png (main app icon)');
    console.log('   - build/icon.ico (Windows installer icon)');
    console.log('   - build/icons/ (platform-specific icons)');

  } catch (error) {
    console.error('✗ Error generating icons:', error);
    process.exit(1);
  }
}

generateIcons();

