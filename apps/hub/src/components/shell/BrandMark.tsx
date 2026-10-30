/** A főapp buszos márkajele, a hub feliratával. */
export function BrandGlyph({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden>
      <rect width="512" height="512" rx="112" fill="#1FB574" />
      <path fill="#090D0C" d="M256 43C173 43 107 107 107 192C107 331 256 469 256 469C256 469 405 331 405 192C405 107 339 43 256 43Z" />
      <rect x="131" y="128" width="250" height="112" rx="26" fill="#1FB574" />
      <rect x="150" y="142" width="46" height="44" rx="9" fill="#090D0C" />
      <rect x="205" y="142" width="46" height="44" rx="9" fill="#090D0C" />
      <rect x="260" y="142" width="46" height="44" rx="9" fill="#090D0C" />
      <rect x="315" y="142" width="46" height="44" rx="9" fill="#090D0C" />
      <rect x="141" y="199" width="228" height="12" rx="6" fill="#090D0C" />
      <circle cx="178" cy="240" r="24" fill="#090D0C" />
      <circle cx="178" cy="240" r="11" fill="#1FB574" />
      <circle cx="334" cy="240" r="24" fill="#090D0C" />
      <circle cx="334" cy="240" r="11" fill="#1FB574" />
    </svg>
  );
}

export function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <BrandGlyph className="h-8 w-8 shrink-0" />
      <div className="leading-tight">
        <div className="text-[15px] font-extrabold tracking-tight">
          MVK<span className="text-primary">++</span>
        </div>
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">rendszer-hub</div>
      </div>
    </div>
  );
}
