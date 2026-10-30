import type { Metadata } from "next";
import { UsagePage } from "@/components/pages/UsagePage";

export const metadata: Metadata = { title: "Használat" };

export default function Page() {
  return <UsagePage />;
}
