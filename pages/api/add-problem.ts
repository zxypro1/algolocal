import { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';
import { ensureLibraryWritable } from '../../src/lib/server/localLibrary';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!ensureLibraryWritable(res)) return;

    const { problem } = req.body;

    if (!problem) {
      return res.status(400).json({ error: 'Problem data is required' });
    }

    // Validate required fields
    const requiredFields = ['id', 'title', 'difficulty', 'description', 'template', 'tests'];
    for (const field of requiredFields) {
      if (!problem[field]) {
        return res.status(400).json({ error: `Field '${field}' is required` });
      }
    }

    // Validate id format
    if (!/^[a-z0-9-]+$/.test(problem.id)) {
      return res.status(400).json({ error: 'ID must contain only lowercase letters, numbers, and hyphens' });
    }

    const appRoot = process.env.APP_ROOT || process.cwd();
    // Read current problems
    const problemsPath = path.join(appRoot, 'public', 'problems.json');
    const problemsData = fs.readFileSync(problemsPath, 'utf8');
    const problems = JSON.parse(problemsData);

    // Check if problem ID already exists
    if (problems.find((p: any) => p.id === problem.id)) {
      return res.status(409).json({ error: 'Problem with this ID already exists' });
    }

    // Add new problem
    problems.push(problem);

    // Write to public/problems.json
    fs.writeFileSync(problemsPath, JSON.stringify(problems, null, 2));

    // Also sync to problems/problems.json
    const sourceProblemsPath = path.join(appRoot, 'problems', 'problems.json');
    fs.writeFileSync(sourceProblemsPath, JSON.stringify(problems, null, 2));

    res.status(201).json({ message: 'Problem added successfully', id: problem.id });
  } catch (error) {
    console.error('Error adding problem:', error);
    res.status(500).json({ error: 'Failed to add problem' });
  }
}