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

    const { problem, originalId } = req.body;

    if (!problem) {
      return res.status(400).json({ error: 'Problem data is required' });
    }

    if (!originalId) {
      return res.status(400).json({ error: 'Original problem ID is required' });
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

    // Find the problem to update
    const problemIndex = problems.findIndex((p: any) => p.id === originalId);
    if (problemIndex === -1) {
      return res.status(404).json({ error: 'Problem not found' });
    }

    // If ID changed, check if new ID already exists
    if (problem.id !== originalId) {
      const existingProblem = problems.find((p: any) => p.id === problem.id);
      if (existingProblem) {
        return res.status(409).json({ error: 'Problem with this ID already exists' });
      }
    }

    // Update the problem
    problems[problemIndex] = problem;

    // Write to public/problems.json
    fs.writeFileSync(problemsPath, JSON.stringify(problems, null, 2));

    // Also sync to problems/problems.json
    const sourceProblemsPath = path.join(appRoot, 'problems', 'problems.json');
    if (fs.existsSync(path.dirname(sourceProblemsPath))) {
      fs.writeFileSync(sourceProblemsPath, JSON.stringify(problems, null, 2));
    }

    res.status(200).json({ message: 'Problem updated successfully', id: problem.id });
  } catch (error) {
    console.error('Error updating problem:', error);
    res.status(500).json({ error: 'Failed to update problem' });
  }
}

