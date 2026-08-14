import type { Metadata } from "next";
import BottomNav from "@/components/mobile/BottomNav";

export const metadata: Metadata = {
  title: "AI 漫剧工坊",
};

/**
 * 移动端布局（/m/* 下所有页面共享）
 * - 限制最大宽度 max-w-md（适配手机竖屏）
 * - 底部固定 Tab 导航
 * - 主内容区底部留白，避免被导航遮挡
 */
export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <main className="flex-1 pb-20">{children}</main>
      <BottomNav />
    </div>
  );
}
