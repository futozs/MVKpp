"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { startUsage, trackView } from "@/lib/usage";

// Utastájékoztató kijelző (tévé, tablet): 1–3 megálló, teljes képernyőn.
const KioskView = dynamic(() => import("@/components/kiosk/KioskView").then((m) => m.KioskView), { ssr: false });

export default function KioskPage() {
  useEffect(() => {
    trackView("kiosk");
    startUsage();
  }, []);
  return <KioskView />;
}
