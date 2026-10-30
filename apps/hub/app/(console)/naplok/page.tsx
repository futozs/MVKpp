import type { Metadata } from "next";
import { LogsPage } from "@/components/pages/LogsPage";

export const metadata: Metadata = { title: "Naplók" };

export default function Page() {
  return <LogsPage />;
}
