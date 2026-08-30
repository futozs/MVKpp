/**
 * Admin token és a telepítő állapotszerverének címe.
 *
 * A token a böngészőben marad (localStorage), és csak kérésfejlécben utazik —
 * a szerver soha nem adja ki, a hub soha nem jeleníti meg olvashatóan.
 */
const TOKEN_KEY = 'mvk.adminToken'

/** A telepítő mini állapotszerverének portja (lásd tools/redeploy.mjs). */
const DEPLOY_STATUS_PORT = '8089'

export function getAdminToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    // Privát ablakban a tároló írása/olvasása dobhat.
    return ''
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* token nélkül is működik minden olvasó funkció */
  }
}

export function adminHeaders(): Record<string, string> {
  return { 'X-Admin-Token': getAdminToken(), 'Content-Type': 'application/json' }
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
