/**
 * A telepítő állapotszerverének címe.
 *
 * A rendszerhub kizárólag helyi hálózaton fut, ezért az üzemeltetési
 * végpontok (naplók, újratelepítés) nem kérnek admin tokent.
 */

/** A manager beépített állapotszerverének portja (lásd manager.mjs). */
const DEPLOY_STATUS_PORT = '8089'

/** Rendszer API alapcíme (Cloudflare Tunnel vs. local). */
export function getSystemUrl(path: string): string {
  if (typeof window === 'undefined') return `http://localhost:8088${path}`
  
  // Dev módban: relatív URL (Vite proxy)
  if (import.meta.env.DEV) {
    return path
  }
  
  // Prod módban:
  // - HTTPS (Cloudflare Tunnel): no port
  // - HTTP (local): explicit :8088
  const { protocol, hostname } = window.location
  if (protocol === 'https:') {
    return `https://${hostname}${path}`
  }
  return `http://${hostname}:8088${path}`
}

/**
 * A telepítő saját állapotszervere — SZÁNDÉKOSAN a proxy megkerülésével.
 *
 * Újratelepítés alatt a gateway és a hub Vite-szervere is le van állítva, tehát
 * a szokásos `/system/...` útvonalak nem élnek. Ez a cím a böngészőből
 * közvetlenül a szerver gépére mutat, ugyanarra a hosztnévre, ahonnan a hub
 * betöltődött — így hálózaton, telefonról is jó.
 */
export function deployStatusUrl(): string {
  if (typeof window === 'undefined') return `http://localhost:${DEPLOY_STATUS_PORT}/`
  const { protocol, hostname } = window.location
  return `${protocol}//${hostname}:${DEPLOY_STATUS_PORT}/`
}
