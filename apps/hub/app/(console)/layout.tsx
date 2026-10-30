import type { ReactNode } from "react";
import { Shell } from "@/components/shell/Shell";

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return <Shell>{children}</Shell>;
}
