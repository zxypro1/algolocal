import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** 出错时显示什么。给了函数就把错误交给它，由调用方决定怎么呈现 */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  /** 换了这个值就重置错误状态：切关卡、切项目之后不该继续显示上一份坏数据的错误 */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 渲染期异常的兜底。
 *
 * React 没有错误边界时，任何一个组件在渲染里抛异常都会让整棵树被卸载——
 * 表现就是整页白屏，而且控制台之外没有任何线索。工程项目的内容有很大一部分
 * 是 AI 生成的，坏数据是常态而不是意外，所以这条路径必须有边界：
 * 一份坏数据最多毁掉它自己那一块，不能把整个应用带走。
 *
 * 只能是 class 组件 —— hooks 没有对应的能力。
 */
export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 白屏最难受的地方是什么都没留下，所以这里一定要把组件栈打出来
    console.error('Render error caught by ErrorBoundary:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    // 没给 fallback 时的最低限度：说清楚是哪儿坏了，而不是一片空白
    return (
      <div style={{ padding: 16, fontSize: 13, lineHeight: 1.6 }}>
        <strong>Something in this view failed to render.</strong>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 8 }}>
          {error.message}
        </pre>
      </div>
    );
  }
}
