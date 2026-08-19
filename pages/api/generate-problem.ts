import type { NextApiRequest, NextApiResponse } from 'next';
import * as fs from 'fs';
import * as path from 'path';
import {
  AIProviderConfig,
  callAI,
  ChatMessage,
  extractJson,
  NoProviderError,
} from '../../src/lib/server/aiProvider';

interface Problem {
  id: string;
  title: {
    en: string;
    zh: string;
  };
  difficulty: 'Easy' | 'Medium' | 'Hard';
  tags: string[];
  description: {
    en: string;
    zh: string;
  };
  examples: Array<{
    input: string;
    output: string;
  }>;
  template: {
    js: string;
    python: string;
    java: string;
    cpp: string;
    c: string;
  };
  solution: {
    js: string;
  };
  solutions: Array<{
    title: {
      en: string;
      zh: string;
    };
    content: {
      en: string;
      zh: string;
    };
  }>;
  tests: Array<{
    input: string;
    output: string;
  }>;
}

const SYSTEM_PROMPT = `You are an expert LeetCode problem generator. Generate high-quality coding problems in the exact JSON format specified. The problem should be original, well-designed, and include comprehensive test cases.

CRITICAL REQUIREMENTS:
1. Return ONLY valid JSON, no additional text or explanations
2. Use kebab-case for the problem ID (e.g., "dynamic-programming-example")
3. Include complete templates for all 5 languages (js, python, java, cpp, c)
4. Provide a working JavaScript solution
5. Include at least 4-5 comprehensive test cases covering edge cases
6. Ensure the problem is solvable and well-defined
7. CRITICAL: ESCAPE ALL special characters properly in JSON strings:
   - Newlines MUST be written as \\n (not actual newlines)
   - Quotes MUST be written as \\\" (not actual quotes)
   - Backslashes MUST be written as \\\\
   - Tabs MUST be written as \\t
8. Make sure all test cases pass with the provided solution
9. Include at least 2 detailed solution explanations in the "solutions" array with markdown formatting
10. ENSURE ALL solutions in the "solutions" array contain COMPLETE working code examples with proper syntax
11. Each solution should have a title and content in both English and Chinese
12. Solutions should include algorithm overview, time/space complexity analysis, implementation, step-by-step explanation, and examples
13. Double-check that your JSON is valid before returning it - parse it to verify`;

function generatePrompt(userRequest: string): string {
  return `Generate a LeetCode-style coding problem based on this request: "${userRequest}"

Return the response in this EXACT JSON format with proper escaping:

{
  "id": "problem-id-in-kebab-case",
  "title": {
    "en": "Problem Title in English",
    "zh": "中文问题标题"
  },
  "difficulty": "Easy|Medium|Hard",
  "tags": ["tag1", "tag2", "tag3"],
  "description": {
    "en": "Detailed problem description in English with clear requirements and constraints. MUST escape all special characters: newlines as \\n, quotes as \\\"", 
    "zh": "详细的中文问题描述，包含清晰的要求和约束条件。必须转义所有特殊字符：换行符为\\n，引号为\\\""
  },
  "examples": [
    {
      "input": "example input format",
      "output": "example output format"
    }
  ],
  "template": {
    "js": "function functionName(param) {\\n  // write your code here\\n}\\nmodule.exports = functionName;",
    "python": "def function_name(param):\\n    # write your code here\\n    pass",
    "java": "public class Solution {\\n    public ReturnType functionName(ParamType param) {\\n        // write your code here\\n        return null;\\n    }\\n}",
    "cpp": "#include <vector>\\n#include <algorithm>\\nusing namespace std;\\n\\nclass Solution {\\npublic:\\n    ReturnType functionName(ParamType param) {\\n        // write your code here\\n        return {};\\n    }\\n};",
    "c": "#include <stdio.h>\\n#include <stdlib.h>\\n\\nReturnType functionName(ParamType param) {\\n    // write your code here\\n    return 0;\\n}"
  },
  "solutions": [
    {
      "title": {
        "en": "Solution Approach Title",
        "zh": "解法标题"
      },
      "content": {
        "en": "Detailed explanation of the solution approach in English with code examples, complexity analysis, and step-by-step walkthrough. MUST escape all special characters: newlines as \\n, quotes as \\\"", 
        "zh": "详细的解法说明，包含中文的代码示例、复杂度分析和逐步演示。必须转义所有特殊字符：换行符为\\n，引号为\\\""
      }
    }
  ],
  "tests": [
    {
      "input": "test input in JSON format",
      "output": "expected output in JSON format"
    }
  ]
}

CRITICAL INSTRUCTIONS - READ CAREFULLY:
1. Return ONLY valid JSON with no additional text or explanations
2. ESCAPE ALL special characters properly:
   - Newlines MUST be written as \\n (not actual newlines)
   - Quotes MUST be written as \\\" (not actual quotes)
   - Backslashes MUST be written as \\\\
   - Tabs MUST be written as \\t
3. Use kebab-case for the problem ID (e.g., "dynamic-programming-example")
4. Include comprehensive test cases that cover edge cases
5. The JavaScript solution must work correctly with all test cases
6. Include at least 2 detailed solution explanations with code examples
7. ENSURE ALL solutions in the "solutions" array contain COMPLETE working code examples with proper syntax
8. Each solution should have a title and content in both English and Chinese
9. Solutions should include algorithm overview, time/space complexity analysis, implementation, step-by-step explanation, and examples
10. Ensure the problem is solvable and well-defined
11. Double-check that your JSON is valid before returning it

Example of properly escaped content:
"description": {
  "en": "This is a multi-line\\ndescription with \\"quotes\\" and special characters.",
  "zh": "这是一个多行\\n描述，包含\\"引号\\"和特殊字符。"
}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { request, config } = req.body as { request?: string; config?: AIProviderConfig };

    if (!request || typeof request !== 'string') {
      return res.status(400).json({ error: 'Request description is required' });
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: generatePrompt(request) },
    ];

    const generatedContent = await callAI(messages, config, { temperature: 0.7, maxTokens: 8000 });

    let problemData: Problem;
    try {
      // 模型经常会加 ```json 围栏，extractJson 会容错处理
      problemData = extractJson<Problem>(generatedContent);
    } catch (parseError) {
      console.error('Failed to parse generated JSON:', generatedContent, parseError);
      return res.status(500).json({
        error: 'Failed to parse generated problem data',
        details: generatedContent,
        rawContent: generatedContent,
      });
    }

    const requiredFields = ['id', 'title', 'difficulty', 'tags', 'description', 'examples', 'template', 'solutions', 'tests'];
    for (const field of requiredFields) {
      if (!problemData[field as keyof Problem]) {
        return res.status(500).json({
          error: `Generated problem is missing required field: ${field}`,
          problemData,
        });
      }
    }

    const appRoot = process.env.APP_ROOT || process.cwd();
    const problemsPath = path.join(appRoot, 'public', 'problems.json');
    let existingProblems: Problem[] = [];

    try {
      existingProblems = JSON.parse(fs.readFileSync(problemsPath, 'utf8'));
    } catch (error) {
      console.error('Error reading problems.json:', error);
      return res.status(500).json({ error: 'Failed to read existing problems' });
    }

    if (existingProblems.find((problem) => problem.id === problemData.id)) {
      let counter = 1;
      let newId = `${problemData.id}-${counter}`;
      while (existingProblems.find((problem) => problem.id === newId)) {
        counter += 1;
        newId = `${problemData.id}-${counter}`;
      }
      problemData.id = newId;
    }

    existingProblems.push(problemData);

    try {
      fs.writeFileSync(problemsPath, JSON.stringify(existingProblems, null, 2), 'utf8');
    } catch (error) {
      console.error('Error writing problems.json:', error);
      return res.status(500).json({ error: 'Failed to save new problem' });
    }

    return res.status(200).json({
      success: true,
      problem: problemData,
      message: `Successfully generated and added problem: ${problemData.title.en}`,
    });
  } catch (error) {
    console.error('Error generating problem:', error);
    const message =
      error instanceof NoProviderError ? error.message : (error as Error).message || 'Unknown error';
    return res.status(500).json({ error: 'Failed to generate problem', details: message });
  }
}
