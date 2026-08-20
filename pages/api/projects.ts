import type { NextApiRequest, NextApiResponse } from 'next';
import { addUserProject, deleteUserProject, loadAllProjects, summarizeProject } from '../../src/lib/server/projectStore';
import { coerceProject, validateProjectShape } from '../../src/lib/engineering/validateProject';
import { ensureLibraryWritable } from '../../src/lib/server/localLibrary';

/**
 * GET    /api/projects        列表用的精简信息（标题、标签、关卡数）
 * GET    /api/projects?id=xxx 单个工程的完整内容，工作区用
 * POST   /api/projects        把一个工程题装进本地题库（工坊保存、市场下载都走这里）
 * DELETE /api/projects?id=xxx 删除一个用户生成的项目
 *
 * 列表和工作区分开：以前两个页面都下载整个题库（295KB，且随生成的题目继续增长），
 * 工作区其实只需要其中一个工程。
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'POST') {
      if (!ensureLibraryWritable(res)) return;

      const project = coerceProject(req.body?.project);
      const problems = validateProjectShape(project);

      // 这份内容可能来自市场上的陌生人。装进题库之前先按和 AI 生成同样的
      // 标准校验一遍，免得点开是一个空白工作区。
      if (problems.length) {
        return res.status(400).json({ error: 'The project failed validation', problems });
      }

      const saved = addUserProject(project);
      return res.status(201).json({ success: true, project: summarizeProject(saved) });
    }

    if (req.method === 'GET') {
      const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
      if (id) {
        const project = loadAllProjects().find((item) => item.id === id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        return res.status(200).json(project);
      }
      return res.status(200).json(loadAllProjects().map(summarizeProject));
    }

    if (req.method === 'DELETE') {
      if (!ensureLibraryWritable(res)) return;

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
