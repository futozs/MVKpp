import type { Metadata } from "next";
import { SourcesPage } from "@/components/pages/SourcesPage";

export const metadata: Metadata = { title: "Adatforrások" };

export default function Page() {
  return <SourcesPage />;
}
