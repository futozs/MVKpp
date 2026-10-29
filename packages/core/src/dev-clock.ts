/**
 * Fejlesztői óra: DEV_CLOCK_AT="2026-10-28T07:30:00+01:00" esetén a folyamat
 * Date.now()-ja ettől a pillanattól indul és valós sebességgel halad. Így egy
 * rögzített nap visszajátszása a menetrenddel összhangban tesztelhető.
 * Élesben nincs beállítva → nincs hatása.
 */
const at = process.env.DEV_CLOCK_AT;
if (at) {
  const target = Date.parse(at);
  if (Number.isFinite(target)) {
    const realNow = Date.now.bind(Date);
    const offset = realNow() - target;
    Date.now = () => realNow() - offset;
    console.log(`[dev-clock] az óra eltolva: ${new Date(Date.now()).toISOString()}`);
  }
}
export {};
