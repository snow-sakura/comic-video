import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import HomePage from "./pages/Home";
import ProjectPage from "./pages/Project";
import SettingsPage from "./pages/Settings";
import TasksPage from "./pages/Tasks";
import MobileShell from "./pages/mobile/Shell";

/**
 * 移动端路由：User-Agent 重定向逻辑（原 Next.js 时代由服务端 proxy.ts 实现，现移至前端）：
 * 移动端 UA 且访问非 /m 路径 → 重定向到 /m
 */
export default function App() {
  useEffect(() => {
    const isMobileUA = /Android|webOS|iPhone|iPad|iPod|Windows Phone/i.test(navigator.userAgent);
    const wantsMobile = new URLSearchParams(window.location.search).get("device") === "mobile";
    if ((isMobileUA && window.innerWidth < 1024) || wantsMobile) {
      const path = window.location.pathname.replace(/^\/m/, "");
      window.location.replace(`/m${path || ""}${window.location.search}`);
    }
  }, []);

  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/projects/:id" element={<ProjectPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/tasks" element={<TasksPage />} />
      <Route path="/m" element={<MobileShell page="home" />} />
      <Route path="/m/projects/:id" element={<MobileShell page="project" />} />
      <Route path="/m/settings" element={<MobileShell page="settings" />} />
      <Route path="/m/tasks" element={<MobileShell page="tasks" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
