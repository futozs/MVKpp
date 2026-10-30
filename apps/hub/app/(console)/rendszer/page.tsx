import type { Metadata } from "next";
import { ServicesPage } from "@/components/pages/ServicesPage";

export const metadata: Metadata = { title: "Szolgáltatások" };

export default function Page() {
  return <ServicesPage />;
}
