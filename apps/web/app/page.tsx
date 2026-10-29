"use client";

import dynamic from "next/dynamic";

// A Leaflet már importáláskor a window-hoz nyúl, ezért az app csak kliensen fut.
const App = dynamic(() => import("@/App"), { ssr: false });

export default function Page() {
  return <App />;
}
