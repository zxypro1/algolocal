import React from 'react';
import { Container, Title, Paper, Space } from '@mantine/core';
import MarkdownRenderer from '../src/components/MarkdownRenderer';

const testMarkdown = `
# Enhanced MarkdownRenderer Test

This page demonstrates all the enhanced features of the MarkdownRenderer component.

## Features

### 1. **Bold**, *Italic*, and \`inline code\` formatting

Regular text with **bold text**, *italic text*, and \`inline code\` formatting.

### 2. Code Blocks with Syntax Highlighting

JavaScript code:
\`\`\`javascript
function twoSum(nums, target) {
  const map = new Map();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (map.has(complement)) {
      return [map.get(complement), i];
    }
    map.set(nums[i], i);
  }
}
\`\`\`

Python code:
\`\`\`python
def two_sum(nums, target):
    num_map = {}
    for i, num in enumerate(nums):
        complement = target - num
        if complement in num_map:
            return [num_map[complement], i]
        num_map[num] = i
    return []
\`\`\`

### 3. Mathematical Formulas (KaTeX)

Inline math: $E = mc^2$

Block math:
$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$

Time complexity: $O(n \\log n)$

Space complexity: $O(1)$

### 4. Complex Tables

| Algorithm | Time Complexity | Space Complexity | Pros | Cons |
|-----------|----------------|------------------|------|------|
| Hash Map | $O(n)$ | $O(n)$ | Fast, optimal | Uses extra space |
| Brute Force | $O(n^2)$ | $O(1)$ | Simple, no extra space | Slow for large inputs |
| Two Pointers | $O(n \\log n)$ | $O(n)$ | Good for sorted arrays | Requires sorting |

### 5. HTML Elements

<div style="background-color: #f0f8ff; padding: 10px; border-radius: 5px; border-left: 4px solid #1976d2;">
  <strong>Note:</strong> This is a custom HTML element with inline styling.
</div>

<br/>

<details>
  <summary><strong>Click to expand details</strong></summary>
  <p>This content is hidden by default and can be toggled by clicking the summary.</p>
  <ul>
    <li>Item 1</li>
    <li>Item 2</li>
    <li>Item 3</li>
  </ul>
</details>

### 6. Mermaid Diagrams

#### Flowchart
\`\`\`mermaid
graph TB
    A[Start] --> B{Is it sorted?}
    B -->|Yes| C[Use Two Pointers]
    B -->|No| D[Use Hash Map]
    C --> E[O(n) time]
    D --> E
    E --> F[End]
\`\`\`

#### Sequence Diagram
\`\`\`mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Backend
    participant Database
    
    User->>Frontend: Submit solution
    Frontend->>Backend: POST /api/run
    Backend->>Database: Save result
    Database-->>Backend: Confirmation
    Backend-->>Frontend: Test results
    Frontend-->>User: Display results
\`\`\`

### 7. Lists and Nested Content

#### Unordered List
- **Algorithm Analysis**
  - Time complexity considerations
  - Space complexity trade-offs
  - Edge cases and constraints
- **Implementation Details**
  - Language-specific optimizations
  - Error handling strategies
  - Testing approaches

#### Ordered List
1. **Understanding the Problem**
   - Read requirements carefully
   - Identify input/output constraints
   - Consider edge cases
2. **Planning the Solution**
   - Choose appropriate data structures
   - Design the algorithm
   - Analyze complexity
3. **Implementation**
   - Write clean, readable code
   - Add comments for clarity
   - Handle edge cases

### 8. Blockquotes

> **Important:** Always consider the time and space complexity of your solution.
> 
> Good algorithms are not just about correctness, but also about efficiency and maintainability.

### 9. Links and References

For more information, visit [LeetCode](https://leetcode.com) or check out [Algorithm Visualizations](https://visualgo.net).

### 10. Mixed Content Example

The **Two Sum** problem can be solved in multiple ways:

| Approach | Implementation | Complexity |
|----------|----------------|------------|
| Brute Force | Nested loops | $O(n^2)$ time, $O(1)$ space |
| Hash Map | Single pass with map | $O(n)$ time, $O(n)$ space |

Here's the optimal solution:

\`\`\`javascript
function twoSum(nums, target) {
  const map = new Map();
  
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    
    if (map.has(complement)) {
      return [map.get(complement), i];
    }
    
    map.set(nums[i], i);
  }
  
  return []; // No solution found
}
\`\`\`

The algorithm works by:
1. Creating a hash map to store seen numbers
2. For each number, calculating its complement: $complement = target - nums[i]$
3. Checking if the complement exists in our map
4. If found, returning the indices; otherwise, storing the current number

**Time Complexity:** $O(n)$ - single pass through the array
**Space Complexity:** $O(n)$ - hash map can store up to n elements

---

## Conclusion

The enhanced MarkdownRenderer now supports:
- **Rich text formatting** (bold, italic, code)
- **Syntax-highlighted code blocks**
- **Mathematical formulas** with KaTeX
- **Complex tables** with proper styling
- **HTML elements** for custom formatting
- **Mermaid diagrams** for flowcharts and sequences
- **All standard Markdown features**

This makes it perfect for technical documentation, algorithm explanations, and educational content!
`;

export default function MarkdownTest() {
  return (
    <Container size="lg" py="xl">
      <Paper shadow="sm" p="xl" withBorder>
        <MarkdownRenderer content={testMarkdown} />
      </Paper>
    </Container>
  );
}