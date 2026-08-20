import { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';
import { ensureLibraryWritable } from '../../src/lib/server/localLibrary';

interface Problem {
  id: string;
  title: { en: string; zh: string };
  difficulty: string;
  tags?: string[];
  description: { en: string; zh: string };
  examples?: Array<{ input: string; output: string }>;
  template: Record<string, string>;
  tests: Array<{ input: string; output: string }>;
  solution?: Record<string, string>;
  solutions?: Array<{
    title: { en: string; zh: string };
    content: { en: string; zh: string };
  }>;
}

function validateProblem(problem: any): problem is Problem {
  if (!problem || typeof problem !== 'object') return false;
  if (typeof problem.id !== 'string' || !problem.id) return false;
  if (!problem.title || typeof problem.title.en !== 'string') return false;
  if (!['Easy', 'Medium', 'Hard'].includes(problem.difficulty)) return false;
  if (!problem.description || typeof problem.description.en !== 'string') return false;
  if (!problem.template || typeof problem.template !== 'object') return false;
  if (!Array.isArray(problem.tests) || problem.tests.length === 0) return false;
  
  // Validate ID format
  if (!/^[a-z0-9-]+$/.test(problem.id)) return false;
  
  return true;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!ensureLibraryWritable(res)) return;

    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Fetch remote JSON
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'OfflineLeetPractice/1.0',
      },
    });

    if (!response.ok) {
      return res.status(400).json({ 
        error: `Failed to fetch remote JSON: ${response.status} ${response.statusText}` 
      });
    }

    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('application/json') && !contentType.includes('text/')) {
      return res.status(400).json({ error: 'Remote URL does not return JSON content' });
    }

    let importedData: any;
    try {
      const text = await response.text();
      importedData = JSON.parse(text);
    } catch {
      return res.status(400).json({ error: 'Failed to parse remote JSON' });
    }

    // Validate and normalize to array
    let importedProblems: any[];
    if (Array.isArray(importedData)) {
      importedProblems = importedData;
    } else if (typeof importedData === 'object' && importedData !== null && importedData.id) {
      // If it's a single problem object, wrap it in an array
      importedProblems = [importedData];
    } else {
      return res.status(400).json({ error: 'Remote JSON must be an array of problems or a single problem object' });
    }

    // Read current problems
    const appRoot = process.env.APP_ROOT || process.cwd();
    const problemsPath = path.join(appRoot, 'public', 'problems.json');
    const problemsData = fs.readFileSync(problemsPath, 'utf8');
    const currentProblems: Problem[] = JSON.parse(problemsData);
    
    const existingIds = new Set(currentProblems.map(p => p.id));

    // Process imported problems
    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (const problem of importedProblems) {
      // Skip if ID already exists
      if (existingIds.has(problem.id)) {
        skipped++;
        continue;
      }

      // Validate problem structure
      if (!validateProblem(problem)) {
        failed++;
        continue;
      }

      // Ensure required fields have defaults
      const normalizedProblem: Problem = {
        id: problem.id,
        title: {
          en: problem.title.en || problem.title.zh || 'Untitled',
          zh: problem.title.zh || problem.title.en || '无标题',
        },
        difficulty: problem.difficulty,
        tags: Array.isArray(problem.tags) ? problem.tags : [],
        description: {
          en: problem.description.en || problem.description.zh || '',
          zh: problem.description.zh || problem.description.en || '',
        },
        examples: Array.isArray(problem.examples) ? problem.examples : [],
        template: problem.template,
        tests: problem.tests,
      };

      // Copy optional fields
      if (problem.solution) {
        normalizedProblem.solution = problem.solution;
      }
      if (problem.solutions) {
        normalizedProblem.solutions = problem.solutions;
      }

      currentProblems.push(normalizedProblem);
      existingIds.add(problem.id);
      success++;
    }

    // Save updated problems
    if (success > 0) {
      fs.writeFileSync(problemsPath, JSON.stringify(currentProblems, null, 2));
      
      // Also sync to problems/problems.json
      const sourceProblemsPath = path.join(appRoot, 'problems', 'problems.json');
      fs.writeFileSync(sourceProblemsPath, JSON.stringify(currentProblems, null, 2));
    }

    return res.status(200).json({
      success,
      failed,
      skipped,
      total: importedProblems.length,
    });
  } catch (error) {
    console.error('Error importing problems:', error);
    return res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to import problems' 
    });
  }
}

