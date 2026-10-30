/**
 * Minden kérés kapuja: belső háló + bejelentkezés.
 * (Next 16: a middleware neve proxy, Node-futtatókörnyezetben fut.)
 */
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/server/env";
import { ipAllowed } from "@/server/netguard";
import { SESSION_COOKIE, verifySession } from "@/server/session";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/me", "/icon-192.png", "/icon-180.png"]);

export function proxy(req: NextRequest) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  if (!ipAllowed(ip, env.allowedCidrs)) {
    return new NextResponse("A rendszer-hub csak belső hálóról érhető el.", { status: 403 });
  }
  const path = req.nextUrl.pathname;
  if (PUBLIC_PATHS.has(path)) return NextResponse.next();
  if (verifySession(req.cookies.get(SESSION_COOKIE)?.value, env.password, env.appSecret)) return NextResponse.next();
  if (path.startsWith("/api/")) return NextResponse.json({ error: "Be kell jelentkezni." }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = path === "/" ? "" : `?next=${encodeURIComponent(path)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|upload/).*)"],
};
