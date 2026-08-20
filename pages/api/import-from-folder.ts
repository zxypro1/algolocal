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
  if (!/^[a-z0-9-]+$/.test(problem.id)) return false;
  return true;
}

function normalizeProblem(problem: any): Problem {
  return {
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
    ...(problem.solution && { solution: problem.solution }),
    ...(problem.solutions && { solutions: problem.solutions }),
  };
}

function findJsonFiles(dir: string): string[] {
  const jsonFiles: string[] = [];
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isFile() && entry.name.endsWith('.json')) {
        jsonFiles.push(fullPath);
      } else if (entry.isDirectory()) {
        // Recursively search subdirectories
        jsonFiles.push(...findJsonFiles(fullPath));
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dir}:`, error);
  }
  
  return jsonFiles;
}

function loadProblemsFromJsonFile(filePath: string): { problems: any[]; error?: string } {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    
    // Handle both array and single object
    if (Array.isArray(data)) {
      return { problems: data };
    } else if (data && typeof data === 'object' && data.id) {
      return { problems: [data] };
    } else {
      return { problems: [], error: 'Invalid JSON structure' };
    }
  } catch (error) {
    return { problems: [], error: error instanceof Error ? error.message : 'Failed to parse JSON' };
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!ensureLibraryWritable(res)) return;

    const { folderPath, useProblemsFolder } = req.body;
    const appRoot = process.env.APP_ROOT || process.cwd();
    
    let targetFolder: string;
    
    if (useProblemsFolder) {
      // Use the default problems folder
      targetFolder = path.join(appRoot, 'problems');
    } else if (folderPath && typeof folderPath === 'string') {
      // Use user-specified folder
      targetFolder = folderPath;
      
      // Security check: ensure the path exists and is a directory
      if (!fs.existsSync(targetFolder)) {
        return res.status(400).json({ error: 'Folder does not exist' });
      }
      
      const stats = fs.statSync(targetFolder);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }
    } else {
      return res.status(400).json({ error: 'Either folderPath or useProblemsFolder is required' });
    }

    // Find all JSON files in the folder
    const jsonFiles = findJsonFiles(targetFolder);
    
    if (jsonFiles.length === 0) {
      return res.status(200).json({
        success: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        message: 'No JSON files found in the folder',
        fileResults: [],
      });
    }

    // Read current problems
    const problemsPath = path.join(appRoot, 'public', 'problems.json');
    let currentProblems: Problem[] = [];
    
    try {
      const problemsData = fs.readFileSync(problemsPath, 'utf8');
      currentProblems = JSON.parse(problemsData);
    } catch {
      // If file doesn't exist or is invalid, start with empty array
      currentProblems = [];
    }
    
    const existingIds = new Set(currentProblems.map(p => p.id));

    // Process each JSON file
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    const fileResults: Array<{ file: string; success: number; failed: number; skipped: number; error?: string }> = [];

    for (const jsonFile of jsonFiles) {
      const relativePath = path.relative(targetFolder, jsonFile);
      const { problems, error } = loadProblemsFromJsonFile(jsonFile);
      
      if (error) {
        fileResults.push({ file: relativePath, success: 0, failed: 0, skipped: 0, error });
        continue;
      }

      let fileSuccess = 0;
      let fileFailed = 0;
      let fileSkipped = 0;

      for (const problem of problems) {
        if (existingIds.has(problem.id)) {
          fileSkipped++;
          totalSkipped++;
          continue;
        }

        if (!validateProblem(problem)) {
          fileFailed++;
          totalFailed++;
          continue;
        }

        const normalizedProblem = normalizeProblem(problem);
        currentProblems.push(normalizedProblem);
        existingIds.add(problem.id);
        fileSuccess++;
        totalSuccess++;
      }

      fileResults.push({ file: relativePath, success: fileSuccess, failed: fileFailed, skipped: fileSkipped });
    }

    // Save updated problems
    if (totalSuccess > 0) {
      fs.writeFileSync(problemsPath, JSON.stringify(currentProblems, null, 2));
      
      // Also sync to problems/problems.json
      const sourceProblemsPath = path.join(appRoot, 'problems', 'problems.json');
      try {
        fs.writeFileSync(sourceProblemsPath, JSON.stringify(currentProblems, null, 2));
      } catch {
        // Ignore if problems folder doesn't exist
      }
    }

    return res.status(200).json({
      success: totalSuccess,
      failed: totalFailed,
      skipped: totalSkipped,
      total: jsonFiles.length,
      fileResults,
    });
  } catch (error) {
    console.error('Error importing from folder:', error);
    return res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to import from folder' 
    });
  }
}

