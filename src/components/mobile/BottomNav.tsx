"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 移动端底部 Tab 导航（固定底部，触控友好）
 * 三个 Tab：项目 / 任务 / 设置
 */
const TABS = [
  { href: "/m", label: "项目", icon: "📁", match: (p: string) => p === "/m" || p.startsWith("/m/projects") },
  { href: "/m/tasks", label: "任务", icon: "📊", match: (p: string) => p.startsWith("/m/tasks") },
  { href: "/m/settings", label: "设置", icon: "⚙️", match: (p: string) => p.startsWith("/m/settings") },
] as const;

export default function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-zinc-800 bg-zinc-900/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex max-w-md items-stretch">
        {TABS.map((tab) => {
          const active = tab.match(pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] transition ${
                active ? "text-violet-300" : "text-zinc-500"
              }`}
            >
              <span className="text-xl leading-none">{tab.icon}</span>
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
