/**
 * A dashboard és a hub Vite-szerverének közös hálózati beállításai.
 *
 * Mindkét app ugyanazt a gateway-t proxyzza és ugyanazokról a hálózatokról kell
 * elérhetőnek lennie, ezért a beállítás egy helyen él — így nem csúszhat szét,
 * ha az egyiket módosítjuk.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** A gateway, amit a dev szerver proxyz. Ugyanazon a gépen fut. */
export const GATEWAY_TARGET = process.env.VITE_GATEWAY ?? 'http://127.0.0.1:8088'

/**
 * Gateway-proxy — ÚJ backend endpoint felvételekor SOSEM igényel módosítást
 * itt.
 *
 * A korábbi megoldás egy kézzel karbantartott útvonal-listát (PROXY_PATHS)
 * adott át a Vite `server.proxy`-jának: ha egy új backend végpont (pl.
 * `/account`) lemaradt róla, a Vite csendben a saját SPA index.html-jét adta
 * vissza rá API-hívásra is — a kliens HTML-t kapott JSON helyett.
 *
 * Ehelyett EGYETLEN, mindent befogó szabály van (minden útvonalra illeszkedik,
 * kivéve a Vite `@`-prefixű saját virtuális moduljait — @vite/client,
 * @react-refresh, @id/, @fs/ —, mert azoknak nincs valódi fájl-megfelelőjük,
 * a Vite-nak magának kell kiszolgálnia őket). A `bypass` függvény dönti el
 * kérésenként, hogy a Vite szolgálja-e ki (mert van hozzá valódi fájl a
 * projektben — forrás, node_modules/.vite optimalizált függőség, vagy egy
 * public/ alá tett statikus fájl — vagy a gyökér HTML-je), vagy a gateway
 * (mert ilyen fájl nincs, tehát csakis API-hívás lehet). Így egy vadonatúj
 * backend prefix AUTOMATIKUSAN működik, mert a döntés a fájlrendszeren
 * alapul, nem egy karbantartott listán.
 */
export function gatewayProxyConfig() {
  // A Vite dev szerver mindig a saját app-gyökeréből indul (lásd
  // manager.mjs: `npm run dev --prefix frontend`/`--prefix hub`), tehát a
  // process.cwd() megbízhatóan az adott app forrásfáját adja.
  const root = process.cwd()

  return {
    '^/(?!@).*$': {
      target: GATEWAY_TARGET,
      changeOrigin: true,
      bypass(req) {
        const urlPath = req.url.split('?')[0]
        // A gyökér és a build-elt HTML-belépőpont a Vite sajátja.
        if (urlPath === '/' || urlPath === '/index.html') return req.url
        try {
          const decoded = decodeURIComponent(urlPath)
          // Két hely jöhet szóba: a projekt gyökere (forrásfájlok, a Vite
          // optimalizált node_modules/.vite/deps gyorsítótára), és a
          // `public/` mappa (a Vite ennek tartalmát a gyökéren szolgálja ki
          // — pl. `public/manifest.webmanifest` -> `/manifest.webmanifest`).
          for (const base of [root, join(root, 'public')]) {
            const filePath = join(base, decoded)
            // Path traversal ellen: a feloldott útnak a bázis alatt kell maradnia.
            if (filePath.startsWith(base) && existsSync(filePath)) return req.url
          }
        } catch {
          // Érvénytelen URL-kódolás — essen át a proxyn, a gateway úgyis 400-at ad rá.
        }
        // Nincs visszatérési érték -> a kérés a gatewayre megy.
      },
    },
  }
}

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
    proxy: gatewayProxyConfig(),
  }
}
