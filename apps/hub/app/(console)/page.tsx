import type { Metadata } from "next";
import { OverviewPage } from "@/components/pages/OverviewPage";

export const metadata: Metadata = { title: { absolute: "Rendszer-hub  MVK++" } };

export default function Page() {
  return <OverviewPage />;
}
