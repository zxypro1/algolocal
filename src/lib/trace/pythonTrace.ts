/**
 * Python 的轨迹采集。
 *
 * 这边不用插桩：CPython 自带 sys.settrace，逐行回调里能直接拿到
 * frame.f_locals 和调用栈，比改 AST 简单也更可靠。
 *
 * 代价是 settrace 会让代码明显变慢，所以只在用户主动点「调试」时才挂上。
 */

import { TRACE_LIMITS, type Breakpoint } from './types';

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
  argsJson: string,
  breakpoints: Breakpoint[] = []
): string {
  // 只把启用的断点传下去，Python 侧按行索引
  const active = breakpoints.filter((breakpoint) => breakpoint.enabled);
  return `
import json, sys
from io import StringIO

_stdout_backup, _stderr_backup = sys.stdout, sys.stderr
sys.stdout, sys.stderr = StringIO(), StringIO()

_trace = []
_dropped = [0]
_breakpoints = json.loads(${JSON.stringify(JSON.stringify(active))})
_by_line = {}
for _bp in _breakpoints:
    _by_line.setdefault(_bp['line'], []).append(_bp)
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

import re as _re

def _render_log(template, frame):
    # {expr} 求值，和 VS Code 的 logpoint 一致
    def _sub(match):
        try:
            return _fmt(eval(match.group(1), frame.f_globals, frame.f_locals))
        except Exception:
            return match.group(0)
    return _re.sub(r'\{([^{}]+)\}', _sub, template)

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
        # 断点在录制时求值：这里能拿到活的 f_locals，
        # 轨迹里存的是 repr 之后的字符串，没法拿来判断条件。
        _hit = False
        _log = None
        for _bp in _by_line.get(frame.f_lineno, []):
            if _bp.get('logMessage'):
                _log = _render_log(_bp['logMessage'], frame)
                continue
            _cond = _bp.get('condition')
            if not _cond:
                _hit = True
                continue
            try:
                if eval(_cond, frame.f_globals, frame.f_locals):
                    _hit = True
            except Exception:
                # 条件在这一帧求值失败就当不命中，别把用户的运行搞崩
                pass

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
        _step = {
            'line': frame.f_lineno,
            'depth': max(len(_stack) - 1, 0),
            'fn': name,
            'vars': variables,
            'stack': list(_stack),
        }
        if _hit:
            _step['hit'] = True
        if _log is not None:
            _step['log'] = _log
        _trace.append(_step)
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
