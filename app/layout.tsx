import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Flora Story - 专属花历",
  description: "记录送出与收到的花束故事"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
