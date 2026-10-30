// A hub API-ja a src/server alatt él; ez csak a bekötés (a belépést és a
// címszűrést a proxy.ts már elvégezte).
import { dataRoutes } from "@/server/api-data";
import { systemRoutes } from "@/server/api-system";
import { dispatch } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const routes = [...systemRoutes, ...dataRoutes];
const handle = (req: Request) => dispatch(routes, req);

export const GET = handle;
export const POST = handle;
