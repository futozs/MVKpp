export interface JwtStatus {
  present: boolean
  exp?: number
  expiresInSec?: number | null
  expired?: boolean
  installationId?: string
}

export interface HealthResponse {
  jwt: JwtStatus
  autoRenew: boolean
  lastRenew: {
    at: string
    ok: boolean
    status?: number
    note?: string
  } | null
  tokenRejected: boolean
  gtfs: {
    feedVersion: string
    stops: number
  }
  installationIdKnown: boolean
}

export interface SystemInfoResponse {
  uptimeSec: number
  nodeVersion: string
  memory: {
    rssMb: number
    heapUsedMb: number
    heapTotalMb: number
  }
  gtfs: {
    feedVersion: string
    stops: number
    routes: number
    trips: number
    shapes: number
  }
  jwt: JwtStatus
  installationId: string | null
}

/** A valós idejű feed-gyorsítótár állapota. */
export interface CacheResponse {
  ttlMs: number
  feeds: {
    path: string
    ageMs: number | null
    status: number
    bytes: number
    inflight: boolean
  }[]
  vehicles: { ageMs: number; count: number } | null
  weather: { ageMs: number } | null
}

/** Visszajelzés egy elvégzett műveletről. */
export interface ActionResult {
  text: string
  ok: boolean
}
