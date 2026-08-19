const fs = require('fs');
const path = require('path');

console.log('Cleaning up test problem...\n');

// Read the current problems.json
const problemsPath = path.join(__dirname, 'public', 'problems.json');
const originalData = fs.readFileSync(problemsPath, 'utf8');
const problems = JSON.parse(originalData);

console.log(`Current number of problems: ${problems.length}`);

// Remove the test problem
const filteredProblems = problems.filter(p => p.id !== 'test-problem');

// Write back to file
fs.writeFileSync(problemsPath, JSON.stringify(filteredProblems, null, 2));

console.log(`✓ Removed test problem. New count: ${filteredProblems.length}`);
console.log('Visit http://localhost:3002 to verify the test problem is gone!');