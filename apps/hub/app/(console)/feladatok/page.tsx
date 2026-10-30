import type { Metadata } from "next";
import { JobsPage } from "@/components/pages/JobsPage";

export const metadata: Metadata = { title: "Feladatok" };

export default function Page() {
  return <JobsPage />;
}
