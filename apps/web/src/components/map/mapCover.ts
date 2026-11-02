/**
 * A térkép alját teljes szélességben takaró panel (követett jármű, utazás —
 * `data-map-cover`) magassága: telefonon ezek alatt nem látszana a busz útja.
 */
export function coveredBottom(container: HTMLElement): number {
  const box = container.getBoundingClientRect();
  let covered = 0;
  for (const el of document.querySelectorAll<HTMLElement>("[data-map-cover]")) {
    const r = el.getBoundingClientRect();
    if (r.width < box.width * 0.6 || r.top >= box.bottom || r.bottom < box.bottom - 4) continue;
    covered = Math.max(covered, box.bottom - r.top);
  }
  // (a lenyitott vonat-menetrend telefonon a térkép nagyobb részét is takarhatja)
  return Math.min(covered, box.height * 0.8);
}

/**
 * Asztalon a jobb szélen a térkép magasságának nagy részét takaró oszlop (a követett
 * vonat menetrendje a kártyával) szélessége: a vonat a mellette maradó rész közepén legyen.
 */
export function coveredRight(container: HTMLElement): number {
  const box = container.getBoundingClientRect();
  let covered = 0;
  for (const el of document.querySelectorAll<HTMLElement>("[data-map-cover]")) {
    const r = el.getBoundingClientRect();
    if (r.width >= box.width * 0.6 || r.height < box.height * 0.6 || r.right < box.right - 24) continue;
    covered = Math.max(covered, box.right - r.left);
  }
  return Math.min(covered, box.width * 0.5);
}
