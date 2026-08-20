/**
 * 当前部署能做什么
 *
 * 打到同源的 /api/environment，不是云端接口 —— 桌面端问的是自己那个本地
 * 服务，断网也能拿到答案。市场的「安装到本地」和工坊的「保存到题库」按
 * writableLibrary 决定是真的写库还是导出成文件。
 */
import { useEffect, useState } from 'react';
import type { EnvironmentInfo } from '../../pages/api/environment';

const FALLBACK: EnvironmentInfo = { version: '', writableLibrary: false, hosted: true };

let cached: EnvironmentInfo | null = null;

export function useEnvironment(): { environment: EnvironmentInfo; loading: boolean } {
  const [environment, setEnvironment] = useState<EnvironmentInfo>(cached || FALLBACK);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (cached) return;

    let cancelled = false;
    fetch('/api/environment')
      .then((response) => (response.ok ? response.json() : FALLBACK))
      .then((info: EnvironmentInfo) => {
        cached = info;
        if (!cancelled) setEnvironment(info);
      })
      // 拿不到就按「不可写」处理：这样最坏的结果是多给一个下载按钮，
      // 而不是点了保存却静默失败
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { environment, loading };
}

export default useEnvironment;
