// A szerveroldali API a @mvk/api csomagban él (keretrendszer-független);
// ez a fájl csak bekötés. A v2-kompatibilis útvonalak (iOS app) is ide futnak.
import { handleApi } from "@mvk/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handleApi;
export const POST = handleApi;
export const PUT = handleApi;
export const DELETE = handleApi;
