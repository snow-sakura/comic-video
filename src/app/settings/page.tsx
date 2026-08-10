import type { Metadata } from "next";
import SettingsPanel from "@/components/SettingsPanel";

export const metadata: Metadata = {
  title: "设置 · AI 漫剧工坊",
};

export default function SettingsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
      <h1 className="mb-6 text-2xl font-bold">设置</h1>
      <SettingsPanel />
    </main>
  );
}
