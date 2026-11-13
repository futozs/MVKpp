/**
 * A hub belépési pontja élesben (a Next standalone server.js elé).
 *
 * A hub közvetlenül a belső hálón figyel, nincs előtte reverse proxy  így a
 * kliens által küldött X-Forwarded-* fejlécekben nem bízhatunk (a címszűrő és
 * az Origin-ellenőrzés hamisítható lenne). Itt minden kérésnél felülírjuk őket
 * a TCP-kapcsolat valódi adataival, mielőtt a Next látná a kérést.
 */
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const originalCreateServer = http.createServer;
http.createServer = function patchedCreateServer(...args) {
  const server = originalCreateServer.apply(this, args);
  server.prependListener("request", (req) => {
    for (const h of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto", "x-real-ip", "forwarded"]) delete req.headers[h];
    req.headers["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  });
  return server;
};

await import(join(dirname(fileURLToPath(import.meta.url)), "server.js"));
