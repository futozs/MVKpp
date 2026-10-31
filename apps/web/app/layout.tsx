import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

// A sorrend számít: az index.css felülírja a Leaflet alapstílusait.
import "leaflet/dist/leaflet.css";
import "@/index.css";

import { Providers } from "./providers";

const FAVICON_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Crect width='512' height='512' rx='112' fill='%231FB574'/%3E%3Cpath fill='%23090D0C' d='M256 43C173 43 107 107 107 192C107 331 256 469 256 469C256 469 405 331 405 192C405 107 339 43 256 43Z'/%3E%3Crect x='131' y='128' width='250' height='112' rx='26' fill='%231FB574'/%3E%3Crect x='236' y='122' width='40' height='8' rx='4' fill='%231FB574'/%3E%3Crect x='150' y='142' width='46' height='44' rx='9' fill='%23090D0C'/%3E%3Crect x='205' y='142' width='46' height='44' rx='9' fill='%23090D0C'/%3E%3Crect x='260' y='142' width='46' height='44' rx='9' fill='%23090D0C'/%3E%3Crect x='315' y='142' width='46' height='44' rx='9' fill='%23090D0C'/%3E%3Crect x='141' y='199' width='228' height='12' rx='6' fill='%23090D0C'/%3E%3Crect x='369' y='132' width='9' height='16' rx='4' fill='%23090D0C'/%3E%3Ccircle cx='364' cy='222' r='8' fill='%23090D0C'/%3E%3Ccircle cx='178' cy='240' r='24' fill='%23090D0C'/%3E%3Ccircle cx='178' cy='240' r='11' fill='%231FB574'/%3E%3Ccircle cx='178' cy='240' r='4' fill='%23090D0C'/%3E%3Ccircle cx='334' cy='240' r='24' fill='%23090D0C'/%3E%3Ccircle cx='334' cy='240' r='11' fill='%231FB574'/%3E%3Ccircle cx='334' cy='240' r='4' fill='%23090D0C'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  // a név marad, az alcím a megyére bővült (a fejléc a felületen változatlan)
  title: "MVK++ — Miskolc és Borsod közlekedése",
  description: "Miskolc és Borsod-Abaúj-Zemplén közlekedése élőben: MVK villamos és busz, Volán és vonat — forgalmi térkép, megállófigyelő, menetrend és statisztika.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: FAVICON_SVG, type: "image/svg+xml" }],
    apple: "/icon-180.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "MVK++",
  },
  // A Next az appleWebApp.capable-ből csak a mobile-web-app-capable-t írja ki;
  // a régi index.html mindkettőt tartalmazta.
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#090D0C",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="hu" className="h-full">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="h-full overflow-hidden bg-app text-ink">
        <div id="root" className="h-full flex flex-col">
          <Providers>{children}</Providers>
        </div>
      </body>
    </html>
  );
}
