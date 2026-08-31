/**
 * A dashboard és a hub Vite-szerverének közös hálózati beállításai.
 *
 * Mindkét app ugyanazt a gateway-t proxyzza és ugyanazokról a hálózatokról kell
 * elérhetőnek lennie, ezért a beállítás egy helyen él — így nem csúszhat szét,
 * ha az egyiket módosítjuk.
 */

/** A gateway, amit a dev szerver proxyz. Ugyanazon a gépen fut. */
export const GATEWAY_TARGET = process.env.VITE_GATEWAY ?? 'http://127.0.0.1:8088'

/** A gateway felé továbbított útvonalak. */
const PROXY_PATHS = [
  '/api', '/live', '/gtfs', '/stats', '/system', '/push',
  '/_health', '/_jwt', '/_export', '/_ingest', '/_renew', '/weather',
]

export const proxyConfig = Object.fromEntries(
  PROXY_PATHS.map((p) => [p, { target: GATEWAY_TARGET, changeOrigin: true }])
)

/**
 * Engedélyezett Host fejlécek.
 *
 * A Vite 5.4.12 óta DNS-rebinding ellen ellenőrzi a Host fejlécet, és a nem
 * ismert NEVEKET 403-mal utasítja el ("Blocked request. This host is not
 * allowed."). IP-címre ez nem vonatkozik — `http://192.168.1.37:5173` mindig
 * működik —, de ha a szervert VPN-en át névvel (pl. `mvk.local`, vagy a
 * WireGuard DNS-neve) éred el, e nélkül a beállítás nélkül nem töltene be.
 *
 * A saját hálózataid nevei a `VITE_ALLOWED_HOSTS` környezeti változóban
 * bővíthetők, vesszővel elválasztva. `VITE_ALLOWED_HOSTS=all` esetén minden
 * név engedélyezett — kényelmes, de ilyenkor a szervert tartsd tűzfal mögött,
 * mert a rebinding-védelem kikapcsol.
 */
export function allowedHosts() {
  const extra = (process.env.VITE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (extra.includes('all') || extra.includes('true')) return true

  return [
    'localhost',
    // A `.` előtag aldomainekre is érvényes — így a saját gépnév és a
    // WireGuard/LAN névfeloldás is működik.
    '.local',
    '.lan',
    '.home',
    '.internal',
    ...extra,
  ]
}

/** A dev szerver közös hálózati blokkja. */
export function serverConfig(port) {
  return {
    fs: { allow: ['..'] },
    port,
    // Minden interfészen: LAN-ról, VPN-ről és telefonról is elérhető.
    host: '0.0.0.0',
    allowedHosts: allowedHosts(),
    // A HMR-nek a BÖNGÉSZŐ által látott hosztnévre kell visszacsatlakoznia,
    // nem a szerver sajátjára — különben távoli eléréskor a websocket a
    // localhostot próbálná, és az oldal folyamatos újracsatlakozást mutatna.
    hmr: { clientPort: Number(process.env.VITE_HMR_PORT ?? port) },
    proxy: proxyConfig,
  }
}
