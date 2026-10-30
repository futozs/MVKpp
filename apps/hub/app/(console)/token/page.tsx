import type { Metadata } from "next";
import { TokenPage } from "@/components/pages/TokenPage";

export const metadata: Metadata = { title: "Token és agent" };

export default function Page() {
  return <TokenPage />;
}
