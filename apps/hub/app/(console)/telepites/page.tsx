import type { Metadata } from "next";
import { DeployPage } from "@/components/pages/DeployPage";

export const metadata: Metadata = { title: "Telepítés" };

export default function Page() {
  return <DeployPage />;
}
