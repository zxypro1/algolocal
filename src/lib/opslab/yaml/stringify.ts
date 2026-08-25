/**
 * 反过来：对象 -> YAML
 *
 * Argo CD 要把「仓库里的期望」和「集群里的现状」摆在一起给人看，
 * `argocd app diff` 打的就是这个。所以序列化的排版要稳定：同一个对象
 * 每次输出必须逐字节一致，否则 diff 里全是噪声。
 */
export function stringifyYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);

  if (value === null || value === undefined) return 'null\n';
  if (typeof value === 'boolean' || typeof value === 'number') return `${value}\n`;
  if (typeof value === 'string') return `${scalar(value)}\n`;

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]\n';
    return value.map((item) => {
      const body = stringifyYaml(item, indent + 2);
      if (isBlock(item)) return `${pad}-\n${body}`;
      return `${pad}- ${body.trimStart()}`;
    }).join('');
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}\n';
  return entries.map(([key, item]) => {
    if (isBlock(item)) {
      const body = stringifyYaml(item, Array.isArray(item) ? indent : indent + 2);
      return `${pad}${key}:\n${body}`;
    }
    return `${pad}${key}: ${stringifyYaml(item, 0)}`;
  }).join('');
}

function isBlock(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}

/**
 * 该不该加引号。
 *
 * 加错了不只是难看：`version: 1.10` 不加引号是数字 1.1，
 * `enabled: "true"` 不加引号就变成布尔值。
 */
function scalar(text: string): string {
  if (text === '') return "''";
  if (text.includes('\n')) return JSON.stringify(text);
  if (/^(true|false|null|~|True|False|yes|no|on|off)$/i.test(text)) return `'${text}'`;
  if (/^-?\d*\.?\d+$/.test(text)) return `'${text}'`;
  if (/^[\s]|[\s]$|[:#{}[\],&*!|>'"%@`]/.test(text)) return JSON.stringify(text);
  return text;
}
