import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/pages/LoginForm";

export const metadata: Metadata = { title: "Belépés" };

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
