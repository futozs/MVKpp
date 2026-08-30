/** A fő dashboard Vite-portja. */
const DASHBOARD_PORT = '5173'

/**
 * A fő dashboard címe ugyanazon a gépen, ahonnan a hub betöltődött —
 * így hálózaton, telefonról is a megfelelő gépre mutat, nem a localhostra.
 */
export function dashboardUrl(): string {
  if (typeof window === 'undefined') return `http://localhost:${DASHBOARD_PORT}`
  const { protocol, hostname } = window.location
  return `${protocol}//${hostname}:${DASHBOARD_PORT}`
}
