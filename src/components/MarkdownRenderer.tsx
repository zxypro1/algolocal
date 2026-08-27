import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';
import { Box, Paper, Text, Table, Code, Title } from '@mantine/core';
import { useTheme } from '../contexts/ThemeContext';
import 'katex/dist/katex.min.css';

interface MarkdownRendererProps {
  content: string;
  /**
   * 内容仍在流式生成中。
   *
   * 生成过程中代码围栏是残缺的，对着半截 mermaid 源码反复调用 mermaid.render()
   * 只会不断失败并抖动布局；这里在流式期间把它降级成普通代码块，
   * 等内容收尾后再渲染成图。
   */
  streaming?: boolean;
}

// Mermaid component that loads dynamically
const MermaidChart: React.FC<{ chart: string }> = ({ chart }) => {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const renderMermaid = async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ 
          startOnLoad: false,
          theme: 'default',
          securityLevel: 'loose'
        });
        
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const { svg } = await mermaid.render(id, chart);
        setSvg(svg);
      } catch (err) {
        console.error('Mermaid rendering error:', err);
        setError('Failed to render diagram');
      }
    };

    if (chart.trim()) {
      renderMermaid();
    }
  }, [chart]);

  if (error) {
    return (
      <Paper p="md" withBorder>
        <Text c="red">Error rendering diagram: {error}</Text>
        <Code block mt="sm">{chart}</Code>
      </Paper>
    );
  }

  if (!svg) {
    return (
      <Paper p="md" withBorder>
        <Text>Loading diagram...</Text>
      </Paper>
    );
  }

  return (
    <Paper p="md" withBorder>
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </Paper>
  );
};

const MarkdownRendererBase: React.FC<MarkdownRendererProps> = ({ content, streaming = false }) => {
  const { colorScheme } = useTheme();
  const components = React.useMemo(() => ({
    // Custom code block renderer with syntax highlighting
    code({ node, inline, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const language = match ? match[1] : '';
      const codeContent = String(children).replace(/\n$/, '');

      // Handle Mermaid diagrams
      if (language === 'mermaid') {
        return streaming ? (
          <Code block>{codeContent}</Code>
        ) : (
          <MermaidChart chart={codeContent} />
        );
      }

      // Handle other code blocks with syntax highlighting
      if (!inline && match) {
        return (
          <SyntaxHighlighter
            style={atomDark}
            language={language}
            PreTag="div"
            // 长行自己横向滚动，不要把容器撑宽
            customStyle={{ maxWidth: '100%', overflowX: 'auto' }}
            {...props}
          >
            {codeContent}
          </SyntaxHighlighter>
        );
      }

      /*
       * 没标语言的围栏（``` 直接跟内容）走下面的行内分支。
       *
       * **不能在这里判 `!inline` 然后渲染成块级** —— react-markdown 新版
       * 不再传 `inline` 属性，于是行内代码也会走进那条分支，
       * 结果是把 <pre> 渲染进 <p>，DOM 嵌套非法（React 会告警，
       * 浏览器会把 <p> 提前闭合，段落排版直接乱掉）。
       *
       * 宽度约束交给 CSS：react-markdown 会把围栏包成 <pre><code>，
       * 而 `.panel-scroll pre` 已经给了 max-width + overflow-x（见 globals.css）。
       */

      // Inline code
      return (
        <Code {...props}>
          {children}
        </Code>
      );
    },
    
    /*
     * 表格。
     *
     * 外面包一层**自己横向滚动**的容器：markdown 表格没有宽度上限，
     * 列一多（gpulab 那几关的对照表有五六列）就会把整个说明面板顶开，
     * 而面板被顶开之后旁边的段落会被视口裁掉半句话。
     *
     * `minWidth: 'min-content'` 是关键的一半：让表格保持"内容最小宽度"，
     * 超出的部分在这层容器里滚，而不是把面板顶开。
     *
     * 注意它得配合 globals.css 里 `.panel-scroll table` 那条才有意义 ——
     * 面板整体开了 `overflow-wrap: anywhere`，若不在单元格里收回来，
     * min-content 会退化成「每列一个字符」，这个 `min-width` 就等于没写。
     */
    table({ children }: any) {
      return (
        <Box style={{ maxWidth: '100%', overflowX: 'auto' }}>
          <Table
            striped
            highlightOnHover
            withTableBorder
            withColumnBorders
            style={{ minWidth: 'min-content' }}
          >
            {children}
          </Table>
        </Box>
      );
    },
    
    // Custom heading renderers using Mantine Title
    h1({ children }: any) {
      return (
        <Title order={1} mb="md" mt="xl">
          {children}
        </Title>
      );
    },
    
    h2({ children }: any) {
      return (
        <Title order={2} mb="md" mt="lg">
          {children}
        </Title>
      );
    },
    
    h3({ children }: any) {
      return (
        <Title order={3} mb="sm" mt="md">
          {children}
        </Title>
      );
    },
    
    h4({ children }: any) {
      return (
        <Title order={4} mb="sm" mt="md">
          {children}
        </Title>
      );
    },
    
    h5({ children }: any) {
      return (
        <Title order={5} mb="xs" mt="sm">
          {children}
        </Title>
      );
    },
    
    h6({ children }: any) {
      return (
        <Title order={6} mb="xs" mt="sm">
          {children}
        </Title>
      );
    },
    
    /*
     * 段落。
     *
     * 1.75 而不是 1.6：中文是全高方块字，没有西文的升部降部撑开行间，
     * 同样的数值看上去要挤一档。这里改了对聊天气泡同样生效 —— 那边也是中英混排。
     */
    p({ children }: any) {
      return (
        <Text mb="sm" style={{ lineHeight: 1.75 }}>
          {children}
        </Text>
      );
    },
    
    // Custom blockquote renderer
    blockquote({ children }: any) {
      return (
        /*
         * 引用块。
         *
         * 原本左边框是写死的 `#339af0`：主题色换了它不跟着换，暗色下那条蓝也偏亮。
         * 改成主题变量，并且去掉外框只留左边这一竖 —— 引用是「插进正文的一段话」，
         * 四面都描边会让它看起来像一个独立的卡片，打断阅读。
         */
        <Paper
          p="sm"
          style={{
            borderLeft: '3px solid var(--mantine-color-blue-filled)',
            borderRadius: 0,
            backgroundColor: colorScheme === 'dark' ? 'var(--mantine-color-dark-6)' : 'var(--mantine-color-gray-0)',
            color: colorScheme === 'dark' ? 'var(--mantine-color-gray-1)' : undefined,
          }}
        >
          {children}
        </Paper>
      );
    }
  }), [colorScheme, streaming]);

  return (
    /**
     * `minWidth: 0` 是关键：这个 Box 常常放在 flex 容器里（关卡说明、聊天气泡），
     * flex item 的默认最小宽度是内容宽度，于是一段很宽的代码块会把整个容器撑开，
     * 旁边的段落跟着按更宽的宽度排版，最后被外层裁掉半句话。
     * 宽内容自己横向滚动，文字照常换行。
     */
    <Box style={{ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeRaw, rehypeKatex]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </Box>
  );
};

/**
 * 聊天里同屏会有很多条消息，但流式期间只有最后一条在变。
 * 加上 memo 之后，其余消息不会跟着每次刷新重新解析 markdown。
 */
export const MarkdownRenderer = React.memo(MarkdownRendererBase);

export default MarkdownRenderer;