import { Link, useSearchParams } from "react-router-dom";
import BottomNav from "@/components/mobile/BottomNav";
import MobileHome from "./Home";
import MobileProject from "./Project";
import MobileSettings from "./Settings";
import MobileTasks from "./Tasks";

/**
 * 移动端布局（/m/* 共享）：
 * - 限制最大宽度 max-w-md（手机竖屏）
 * - 底部固定 Tab 导航
 * - 主内容区底部留白避免被导航遮挡
 * - 桌面端访问 /m 时提供「切换到桌面版」（清除 device cookie）
 */
export default function MobileShell({ page }: { page: "home" | "project" | "settings" | "tasks" }) {
  const [sp] = useSearchParams();
  const content =
    page === "home" ? <MobileHome /> :
    page === "project" ? <MobileProject /> :
    page === "settings" ? <MobileSettings /> :
    <MobileTasks />;

  function backToDesktop() {
    document.cookie = "device=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    const path = window.location.pathname.replace(/^\/m/, "") || "/";
    window.location.replace(`${path}${window.location.search}`);
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <main className="flex-1 pb-20">{content}</main>
      <div className="fixed bottom-14 left-0 right-0 z-40 mx-auto w-full max-w-md px-4">
        <button
          onClick={backToDesktop}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900/95 py-1.5 text-xs text-zinc-400 backdrop-blur"
        >
          切换到桌面版
        </button>
      </div>
      <BottomNav />
      {sp.get("device") === "desktop" && (
        <Link to="/" className="sr-only">桌面版</Link>
      )}
    </div>
  );
}
