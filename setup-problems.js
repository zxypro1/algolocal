const fs = require('fs');
const path = require('path');

// Copy problems.json to public folder for runtime access
const sourceFile = path.join(__dirname, 'problems', 'problems.json');
const targetFile = path.join(__dirname, 'public', 'problems.json');

try {
  // Ensure public directory exists
  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  // Copy the file
  fs.copyFileSync(sourceFile, targetFile);
  console.log('✓ Copied problems.json to public folder for runtime access');
} catch (error) {
  console.error('✗ Failed to copy problems.json:', error);
  process.exit(1);
}