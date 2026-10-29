"use client";

import dynamic from "next/dynamic";

// Utastájékoztató kijelző (tévé, tablet): 1–3 megálló, teljes képernyőn.
const KioskView = dynamic(() => import("@/components/kiosk/KioskView").then((m) => m.KioskView), { ssr: false });

export default function KioskPage() {
  return <KioskView />;
}
