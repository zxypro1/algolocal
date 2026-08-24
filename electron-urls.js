/**
 * 导航地址判定
 *
 * 单独成模块是为了能被测试直接 require（不碰 electron），也因为这段是安全相关的：
 * 原来的写法是 `url.includes('localhost')`，`https://evil.example/?x=localhost`
 * 就能骗过去。Electron 安全文档明确要求按解析出来的 origin 判断，不要做字符串包含。
 */

/** 是不是应用自己的页面 */
function isInternalUrl(candidate, { hostname, port }) {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== hostname) return false;
    // 端口不同就是另一个服务，哪怕主机名一样
    return parsed.port === String(port);
  } catch {
    return false;
  }
}

/**
 * 能不能交给系统浏览器打开。
 *
 * 只放行 http(s)：file:// 会用默认程序打开本地文件，javascript: / data: 更不该
 * 经由 shell.openExternal 出去。
 */
function isSafeExternalUrl(candidate) {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = { isInternalUrl, isSafeExternalUrl };
