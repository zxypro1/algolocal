/**
 * Python 的轨迹采集。
 *
 * 这边不用插桩：CPython 自带 sys.settrace，逐行回调里能直接拿到
 * frame.f_locals 和调用栈，比改 AST 简单也更可靠。
 *
 * 代价是 settrace 会让代码明显变慢，所以只在用户主动点「调试」时才挂上。
 */

import { TRACE_LIMITS } from './types';

/**
 * 生成跑在 Pyodide 里的 Python 源码。
 *
 * 约定：
 * - `__user_source` 是用户代码，会在一个干净的命名空间里 exec；
 * - 结果放在 `_result` / `_error`；
 * - 轨迹放在 `_trace`，形状和 JS 那边的 TraceStep 对齐。
 */
export function buildPythonTraceProgram(
  userCode: string,
  functionName: string,
  argsJson: string
): string {
  return `
import json, sys
from io import StringIO

_stdout_backup, _stderr_backup = sys.stdout, sys.stderr
sys.stdout, sys.stderr = StringIO(), StringIO()

_trace = []
_dropped = [0]
_MAX_STEPS = ${TRACE_LIMITS.maxSteps}
_MAX_VALUE = ${TRACE_LIMITS.maxValueChars}
_MAX_VARS = ${TRACE_LIMITS.maxVarsPerStep}
_stack = []

def _fmt(value):
    try:
        text = repr(value)
    except Exception:
        text = '[unreadable]'
    if len(text) > _MAX_VALUE:
        text = text[:_MAX_VALUE] + '\\u2026'
    return text

def _tracer(frame, event, arg):
    name = frame.f_code.co_name
    # 只跟用户代码，别把 json/StringIO 这些库函数也录进来
    if frame.f_code.co_filename != '<user>':
        return None

    if event == 'call':
        _stack.append(name)
        return _tracer

    if event == 'return':
        if _stack:
            _stack.pop()
        return None

    if event == 'line':
        if len(_trace) >= _MAX_STEPS:
            _dropped[0] += 1
            return _tracer
        variables = []
        for key, value in list(frame.f_locals.items()):
            if key.startswith('__'):
                continue
            if len(variables) >= _MAX_VARS:
                break
            variables.append({'name': key, 'value': _fmt(value)})
        _trace.append({
            'line': frame.f_lineno,
            'depth': max(len(_stack) - 1, 0),
            'fn': name,
            'vars': variables,
            'stack': list(_stack),
        })
    return _tracer

_result = None
_error = None
_ns = {}

try:
    _compiled = compile(${JSON.stringify(userCode)}, '<user>', 'exec')
    exec(_compiled, _ns)
    _args = json.loads(${JSON.stringify(argsJson)})
    _fn = _ns.get(${JSON.stringify(functionName)})
    if _fn is None:
        raise NameError("function '" + ${JSON.stringify(functionName)} + "' is not defined")
    sys.settrace(_tracer)
    try:
        _result = _fn(*_args) if len(_args) != 1 else _fn(_args[0])
    finally:
        sys.settrace(None)
except Exception as exc:
    sys.settrace(None)
    _error = str(exc)

_stdout_content = sys.stdout.getvalue()
_stderr_content = sys.stderr.getvalue()
sys.stdout, sys.stderr = _stdout_backup, _stderr_backup

{
    "result": _result if _error is None else None,
    "error": _error,
    "stdout": _stdout_content,
    "stderr": _stderr_content,
    "trace": json.dumps({
        "steps": _trace,
        "droppedSteps": _dropped[0],
        "truncated": _dropped[0] > 0,
        "completed": _error is None,
        "error": _error,
    }),
}
`.trim();
}
