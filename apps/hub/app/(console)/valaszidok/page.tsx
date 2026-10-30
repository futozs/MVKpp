import type { Metadata } from "next";
import { MetricsPage } from "@/components/pages/MetricsPage";

export const metadata: Metadata = { title: "Válaszidők" };

export default function Page() {
  return <MetricsPage />;
}
