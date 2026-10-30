import type { Metadata } from "next";
import { DbPage } from "@/components/pages/DbPage";

export const metadata: Metadata = { title: "Adatbázis" };

export default function Page() {
  return <DbPage />;
}
