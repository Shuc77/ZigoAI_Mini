import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ZigoAI Mini · AI 销售助手',
  description: 'AI Sales Agent —— 读懂客户、判断阶段、给出下一步动作',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
