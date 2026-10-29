"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/** Ugyanaz, mint a régi main.tsx-ben: csak éles buildben, az oldal betöltése után. */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (process.env.NODE_ENV !== "production") return;

  const register = () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  };

  // Az app hidratálás után indul, ilyenkor a load esemény már lefuthatott.
  if (document.readyState === "complete") {
    register();
    return;
  }
  window.addEventListener("load", register, { once: true });
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  useEffect(registerServiceWorker, []);

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
