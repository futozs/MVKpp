/** Adatfrissítéskor a fejléc alján végigfutó jel — csak amíg tényleg tölt. */
export function RefreshSweep({ isRefreshing }: { isRefreshing: boolean }) {
  return (
    <div aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden">
      {isRefreshing ? (
        <span className="block h-full w-1/4 rounded-full bg-gradient-to-r from-transparent via-primary to-transparent motion-safe:animate-tick-sweep" />
      ) : null}
    </div>
  );
}
