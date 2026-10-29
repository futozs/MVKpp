const HUB_PORT = "5174";

/**
 * A rendszerpult címe ugyanazon a gépen, ahonnan az oldal betöltődött.
 *
 * A korábbi fix `http://localhost:5174` csak a fejlesztő gépén működött:
 * telefonról vagy a hálózat másik gépéről megnyitva a saját localhost-jára
 * mutatott. Így a protokoll és a hosztnév a jelenlegi címből jön, és csak a
 * port cserélődik.
 */
export function hubUrl(): string {
  if (typeof window === "undefined") return `http://localhost:${HUB_PORT}`;
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${HUB_PORT}`;
}
