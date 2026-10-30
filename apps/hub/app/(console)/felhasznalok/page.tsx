import type { Metadata } from "next";
import { UsersPage } from "@/components/pages/UsersPage";

export const metadata: Metadata = { title: "Felhasználók" };

export default function Page() {
  return <UsersPage />;
}
