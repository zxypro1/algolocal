import type { NextApiRequest, NextApiResponse } from 'next';
import { deleteUserProject, loadAllProjects } from '../../src/lib/server/projectStore';

/**
 * GET    /api/projects        列出全部工程实战项目（预置 + 用户生成）
 * DELETE /api/projects?id=xxx 删除一个用户生成的项目
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      return res.status(200).json(loadAllProjects());
    }

    if (req.method === 'DELETE') {
      const id = String(req.query.id || '');
      if (!id) return res.status(400).json({ error: 'Project id is required' });

      const removed = deleteUserProject(id);
      if (!removed) {
        return res.status(404).json({ error: 'Only AI-generated projects can be deleted' });
      }
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Error handling /api/projects:', error);
    return res.status(500).json({
      error: 'Failed to load projects: ' + (error as Error).message,
    });
  }
}
