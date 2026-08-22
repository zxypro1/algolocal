/**
 * 把 console.* 的参数格式化成人能读的字符串。
 *
 * 直接 String(arg) 会把对象变成 [object Object]，而直接 JSON.stringify 会在
 * 循环引用上抛错、并且丢掉 Map / Set / undefined / 函数 / Symbol / BigInt。
 * 这里统一处理，算法题和工程题两条执行路径共用。
 */

export const CONSOLE_LIMITS = {
  /** 单条日志的最大字符数，超出截断 */
  maxEntryChars: 2000,
  /** 单次运行最多保留多少条日志 */
  maxEntries: 200,
  /** 对象 / 数组的最大展开深度 */
  maxDepth: 4,
  /** 数组最多展示多少个元素 */
  maxArrayItems: 100,
  /** 对象最多展示多少个键 */
  maxObjectKeys: 50,
} as const;

function formatFunction(value: Function): string {
  return value.name ? `[Function: ${value.name}]` : '[Function (anonymous)]';
}

function formatError(value: Error): string {
  // 堆栈通常已经以 "Name: message" 开头，避免重复
  if (value.stack && value.stack.startsWith(`${value.name}: ${value.message}`)) {
    return value.stack;
  }
  const head = `${value.name}: ${value.message}`;
  return value.stack ? `${head}\n${value.stack}` : head;
}

function quoteKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function formatValue(value: unknown, depth: number, seen: Set<object>): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  const type = typeof value;

  // 顶层字符串按原样输出（console.log('hi') 就该显示 hi），
  // 嵌套字符串加引号，否则 { a: '2' } 和 { a: 2 } 看起来一模一样。
  if (type === 'string') return depth === 0 ? (value as string) : JSON.stringify(value);
  if (type === 'number' || type === 'boolean') return String(value);
  if (type === 'bigint') return `${value}n`;
  if (type === 'symbol') return String(value);
  if (type === 'function') return formatFunction(value as Function);

  const obj = value as object;

  if (value instanceof Error) return formatError(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return String(value);

  if (seen.has(obj)) return '[Circular]';
  if (depth > CONSOLE_LIMITS.maxDepth) return Array.isArray(value) ? '[Array]' : '[Object]';

  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      const shown = value.slice(0, CONSOLE_LIMITS.maxArrayItems);
      const parts = shown.map((item) => formatValue(item, depth + 1, seen));
      if (value.length > shown.length) {
        parts.push(`… ${value.length - shown.length} more`);
      }
      return `[${parts.join(', ')}]`;
    }

    if (value instanceof Map) {
      const parts: string[] = [];
      let count = 0;
      for (const [k, v] of value) {
        if (count >= CONSOLE_LIMITS.maxObjectKeys) {
          parts.push(`… ${value.size - count} more`);
          break;
        }
        parts.push(`${formatValue(k, depth + 1, seen)} => ${formatValue(v, depth + 1, seen)}`);
        count += 1;
      }
      return `Map(${value.size}) {${parts.length ? ` ${parts.join(', ')} ` : ''}}`;
    }

    if (value instanceof Set) {
      const parts: string[] = [];
      let count = 0;
      for (const item of value) {
        if (count >= CONSOLE_LIMITS.maxArrayItems) {
          parts.push(`… ${value.size - count} more`);
          break;
        }
        parts.push(formatValue(item, depth + 1, seen));
        count += 1;
      }
      return `Set(${value.size}) {${parts.length ? ` ${parts.join(', ')} ` : ''}}`;
    }

    // 普通对象（含 class 实例）
    const keys = Object.keys(obj);
    const shownKeys = keys.slice(0, CONSOLE_LIMITS.maxObjectKeys);
    const parts = shownKeys.map(
      (key) => `${quoteKey(key)}: ${formatValue((obj as Record<string, unknown>)[key], depth + 1, seen)}`
    );
    if (keys.length > shownKeys.length) {
      parts.push(`… ${keys.length - shownKeys.length} more`);
    }

    const ctor = (obj as any).constructor;
    const prefix = ctor && ctor.name && ctor.name !== 'Object' ? `${ctor.name} ` : '';
    return `${prefix}{${parts.length ? ` ${parts.join(', ')} ` : ''}}`;
  } finally {
    // 同一个对象在兄弟位置出现多次不该被当成循环引用，
    // 所以离开这一层时把它移出。
    seen.delete(obj);
  }
}

/** 格式化单个值。字符串保持原样（不加引号），与浏览器 console 的行为一致。 */
export function formatConsoleValue(value: unknown): string {
  return formatValue(value, 0, new Set());
}

/** 格式化 console.* 的一组参数，用空格连接。 */
export function formatConsoleArgs(args: unknown[]): string {
  const text = args.map((arg) => formatConsoleValue(arg)).join(' ');
  if (text.length <= CONSOLE_LIMITS.maxEntryChars) return text;
  const omitted = text.length - CONSOLE_LIMITS.maxEntryChars;
  return `${text.slice(0, CONSOLE_LIMITS.maxEntryChars)}… (${omitted} more characters truncated)`;
}
