import type { Metadata } from "next";
import { PushPage } from "@/components/pages/PushPage";

export const metadata: Metadata = { title: "Push" };

export default function Page() {
  return <PushPage />;
}
