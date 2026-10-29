import { notificationPermission } from "@/lib/notifications";

/**
 * Miért nem lehet értesítést kérni: a böngésző letiltotta, vagy egyáltalán nem
 * tudja (iPhone-on Safari-lapon nincs értesítés, csak a kezdőképernyőre tett appban).
 */
export function PermissionNote() {
  const unsupported = notificationPermission() === "unsupported";
  return (
    <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {unsupported
        ? "Ez a böngésző nem tud értesítést küldeni. iPhone-on add hozzá az oldalt a kezdőképernyőhöz (Megosztás → Főképernyőhöz adás), és onnan megnyitva kérhetsz értesítést."
        : "A böngésző letiltotta az értesítéseket ehhez az oldalhoz. Engedélyezd a böngésző beállításaiban (a címsor melletti lakat ikonnál), majd próbáld újra."}
    </p>
  );
}
