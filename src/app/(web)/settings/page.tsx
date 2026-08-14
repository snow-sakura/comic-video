import type { Metadata } from "next";
import SettingsPageClient from "@/components/web/SettingsPageClient";

export const metadata: Metadata = {
  title: "设置 · AI 漫剧工坊",
};

export default function SettingsPage() {
  return <SettingsPageClient />;
}
