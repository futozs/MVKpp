import type { Metadata } from "next";
import { BackupsPage } from "@/components/pages/BackupsPage";

export const metadata: Metadata = { title: "Mentések" };

export default function Page() {
  return <BackupsPage />;
}
