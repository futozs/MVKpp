/** Minimális HTTP-router node:http fölött (a worker API-ja kicsi, nem kell keretrendszer). */
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";

export type Req = IncomingMessage & { path: string; query: URLSearchParams; params: Record<string, string>; body?: Buffer; ip: string };
export type Handler = (req: Req, res: ServerResponse) => Promise<unknown> | unknown;

type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler };

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler) {
    const keys: string[] = [];
    const src = path
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\/:(\w+)/g, (_, k) => {
        keys.push(k);
        return "/([^/]+)";
      })
      .replace(/\\\*$|\*$/, "(.*)");
    this.routes.push({ method, pattern: new RegExp(`^${src}$`), keys, handler });
    return this;
  }
  get(p: string, h: Handler) {
    return this.on("GET", p, h);
  }
  post(p: string, h: Handler) {
    return this.on("POST", p, h);
  }
  all(p: string, h: Handler) {
    return this.on("*", p, h);
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== "*" && r.method !== method && !(method === "HEAD" && r.method === "GET")) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      if (r.keys.length < m.length - 1) params["*"] = m[m.length - 1] ?? "";
      return { route: r, params };
    }
    return null;
  }
}

export function readBody(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("túl nagy kérés"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function sendJson(req: IncomingMessage, res: ServerResponse, status: number, data: unknown, extraHeaders: Record<string, string> = {}) {
  const body = Buffer.from(JSON.stringify(data));
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", ...extraHeaders };
  if (body.length > 1024 && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    const gz = gzipSync(body, { level: 5 });
    headers["content-encoding"] = "gzip";
    headers.vary = "accept-encoding";
    res.writeHead(status, headers);
    res.end(gz);
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
