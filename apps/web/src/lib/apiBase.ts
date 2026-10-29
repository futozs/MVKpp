/**
 * A backend alap-URL-je. Alapból üres: minden hívás ugyanarra az originre megy,
 * ahonnan az oldal jött (a Next rewrites vagy egy reverse proxy továbbítja).
 * Külön backendhez a build előtt állítsd be a NEXT_PUBLIC_API_BASE-t.
 */
export const API_BASE: string = process.env.NEXT_PUBLIC_API_BASE ?? "";
