import type { Metadata } from "next";
import { MvkPage } from "@/components/pages/MvkPage";

export const metadata: Metadata = { title: "MVK API" };

export default function Page() {
  return <MvkPage />;
}
