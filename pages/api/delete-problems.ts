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

    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Problem IDs array is required' });
    }

    // Validate all IDs are strings
    if (!ids.every(id => typeof id === 'string')) {
      return res.status(400).json({ error: 'All IDs must be strings' });
    }

    const appRoot = process.env.APP_ROOT || process.cwd();
    
    // Read current problems
    const problemsPath = path.join(appRoot, 'public', 'problems.json');
    const problemsData = fs.readFileSync(problemsPath, 'utf8');
    const problems: any[] = JSON.parse(problemsData);

    // Create a set of IDs to delete for efficient lookup
    const idsToDelete = new Set(ids);
    
    // Filter out problems to delete
    const remainingProblems = problems.filter(p => !idsToDelete.has(p.id));
    
    // Calculate how many were actually deleted
    const deletedCount = problems.length - remainingProblems.length;
    
    if (deletedCount === 0) {
      return res.status(404).json({ error: 'No matching problems found to delete' });
    }

    // Save updated problems
    fs.writeFileSync(problemsPath, JSON.stringify(remainingProblems, null, 2));
    
    // Also sync to problems/problems.json
    const sourceProblemsPath = path.join(appRoot, 'problems', 'problems.json');
    fs.writeFileSync(sourceProblemsPath, JSON.stringify(remainingProblems, null, 2));

    return res.status(200).json({
      message: 'Problems deleted successfully',
      deletedCount,
      remainingCount: remainingProblems.length,
    });
  } catch (error) {
    console.error('Error deleting problems:', error);
    return res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to delete problems' 
    });
  }
}

