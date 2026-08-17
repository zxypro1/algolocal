import React, { useState, useEffect, useRef } from 'react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell } from 'recharts';

type SparkBarChartProps = {
  values: number[];
  labels?: string[];
  height?: number;
  barColor?: string;
  backgroundColor?: string;
  hideXAxis?: boolean;
};

export function SparkBarChart({
  values,
  labels,
  height = 56,
  barColor = 'var(--mantine-color-blue-filled)',
  backgroundColor = 'transparent',
  hideXAxis = false,
}: SparkBarChartProps) {
  const [fillColor, setFillColor] = useState<string>('#228be6');
  const colorRef = useRef<HTMLDivElement>(null);

  // 提取颜色值（处理CSS变量）
  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (barColor.startsWith('var(--')) {
      // 使用 ref 元素获取计算后的颜色值
      if (colorRef.current) {
        colorRef.current.style.color = barColor;
        const computed = window.getComputedStyle(colorRef.current).color;
        if (computed && computed !== 'rgba(0, 0, 0, 0)' && computed !== 'transparent') {
          setFillColor(computed);
          return;
        }
      }
      
      // 回退到默认颜色映射
      if (barColor.includes('blue')) setFillColor('#228be6');
      else if (barColor.includes('green')) setFillColor('#51cf66');
      else if (barColor.includes('indigo')) setFillColor('#5c7cfa');
      else if (barColor.includes('teal')) setFillColor('#20c997');
      else setFillColor('#228be6');
    } else {
      setFillColor(barColor);
    }
  }, [barColor]);

  // 将数据转换为 recharts 格式
  const data = values.map((value, index) => ({
    name: labels?.[index] || `${index + 1}`,
    value,
  }));

  const maxValue = Math.max(...values, 1);

  return (
    <div
      style={{
        width: '100%',
        height: hideXAxis ? height + 20 : height + 80, // 为坐标轴留出空间
        background: backgroundColor,
        borderRadius: 8,
        position: 'relative',
      }}
    >
      {/* 隐藏元素用于获取CSS变量颜色值 */}
      <div ref={colorRef} style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }} />
      {/* @ts-ignore - recharts ResponsiveContainer type compatibility issue with React types */}
      <ResponsiveContainer width="100%" height="100%">
        {/* @ts-ignore - recharts BarChart type compatibility issue with React types */}
        <BarChart
          data={data}
          margin={{ top: 5, right: 5, left: 5, bottom: hideXAxis ? 5 : 30 }}
          barCategoryGap="15%"
        >
          {(!hideXAxis ? (
            // @ts-ignore - recharts XAxis type compatibility issue
            <XAxis
              dataKey="name"
              tick={{ fontSize: 9, fill: 'var(--mantine-color-dimmed)' }}
              tickLine={{ stroke: 'var(--mantine-color-gray-4)' }}
              axisLine={{ stroke: 'var(--mantine-color-gray-4)' }}
              angle={-45}
              textAnchor="end"
              height={50}
              interval={0}
            />
          ) : null) as any}
          {/* @ts-ignore - recharts YAxis type compatibility issue */}
          <YAxis
            tick={{ fontSize: 9, fill: 'var(--mantine-color-dimmed)' }}
            tickLine={{ stroke: 'var(--mantine-color-gray-4)' }}
            axisLine={{ stroke: 'var(--mantine-color-gray-4)' }}
            width={35}
            domain={[0, maxValue === 0 ? 1 : maxValue * 1.1]}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--mantine-color-body)',
              border: '1px solid var(--mantine-color-gray-4)',
              borderRadius: 6,
            }}
            labelStyle={{ color: 'var(--mantine-color-text)' }}
            itemStyle={{ color: 'var(--mantine-color-text)' }}
          />
          {/* @ts-ignore - recharts Bar type compatibility issue */}
          <Bar dataKey="value" radius={[3, 3, 0, 0]}>
            {/* @ts-ignore - recharts Cell type compatibility issue with React types */}
            {data.map((entry, index) => (
              // @ts-ignore - recharts Cell component type issue
              <Cell
                key={`cell-${index}`}
                fill={entry.value === 0 ? `${fillColor}40` : fillColor}
                opacity={entry.value === 0 ? 0.3 : 1}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
