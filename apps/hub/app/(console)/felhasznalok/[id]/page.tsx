import type { Metadata } from "next";
import { UserDetailPage } from "@/components/pages/UserDetailPage";

export const metadata: Metadata = { title: "Felhasználó" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UserDetailPage id={id} />;
}
