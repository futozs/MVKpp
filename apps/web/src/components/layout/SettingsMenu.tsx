import { useEffect, useId, useState } from "react";
import { Cloud, CloudOff, ChevronRight, Settings, UserRound } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getSession } from "@/lib/account";
import { HEADER_PREFS, useToggle, WATCH_FEATURES, type PrefItem } from "@/lib/watchPrefs";
import { cn } from "@/lib/utils";
import { useGeo } from "@/context/GeoContext";
import { HeaderPopover } from "./HeaderPopover";
import { FOCUS_RING, FOCUS_RING_INSET, ICON_BUTTON } from "./headerStyles";

interface SettingsMenuProps {
  /**
   * Ha meg van adva, a menüben „Fiók és felhős mentés” sor is van — ott,
   * ahol a fejlécben nem fér el külön fiók-gomb.
   */
  onOpenAccount?: () => void;
  /** A fiók-sor láthatósága (pl. `lg:hidden`, ha nagyobb kijelzőn külön gomb van). */
  accountItemClassName?: string;
  /** Mobil: 44 px-es trigger, a panel a felső sáv teljes szélességén. */
  isTouch?: boolean;
}

/** Be van-e jelentkezve (a felhős szinkron csak akkor fut). */
function useSignedIn(): boolean {
  const [on, setOn] = useState(() => Boolean(getSession()));
  useEffect(() => {
    const update = () => setOn(Boolean(getSession()));
    window.addEventListener("mvk-session-change", update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener("mvk-session-change", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return on;
}

/** Egy kapcsolósor: felirat, rövid magyarázat, kapcsoló (44 px-es érintési felülettel). */
function ToggleRow({ item }: { item: PrefItem<string> }) {
  const [on, setOn] = useToggle(item.key);
  const switchId = useId();
  const descriptionId = useId();
  return (
    <div className="flex items-start gap-3 rounded-md px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <label htmlFor={switchId} className="block cursor-pointer text-[13px] font-semibold text-foreground">
          {item.label}
        </label>
        <p id={descriptionId} className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {item.hint}
        </p>
      </div>
      <Switch
        id={switchId}
        checked={on !== false}
        onCheckedChange={setOn}
        aria-describedby={descriptionId}
        className="relative mt-0.5 after:absolute after:-inset-3 after:content-[''] focus-visible:ring-offset-popover"
      />
    </div>
  );
}

/** A helymeghatározás ki-be kapcsolása (eszközönként; a helyzet sosem megy fel a felhőbe). */
function LocationRow() {
  const geo = useGeo();
  const switchId = useId();
  const descriptionId = useId();
  const on = geo.status === "watching" || geo.status === "requesting";
  return (
    <section className="p-1.5">
      <h3 className="px-2.5 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Helyzet</h3>
      <div className="flex items-start gap-3 rounded-md px-2.5 py-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={switchId} className="block cursor-pointer text-[13px] font-semibold text-foreground">
            Helymeghatározás
          </label>
          <p id={descriptionId} className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {geo.status === "denied"
              ? "A böngésző letiltotta ehhez az oldalhoz — a böngésző beállításaiban engedélyezheted."
              : "Ebből számoljuk a sétát, az „Elérem?”-et és a felszállás felismerését. Csak ezen az eszközön marad."}
          </p>
        </div>
        <Switch
          id={switchId}
          checked={on}
          disabled={geo.status === "denied" || geo.status === "unavailable"}
          onCheckedChange={(v) => (v ? geo.start() : geo.stop())}
          aria-describedby={descriptionId}
          className="relative mt-0.5 after:absolute after:-inset-3 after:content-[''] focus-visible:ring-offset-popover"
        />
      </div>
    </section>
  );
}

function Group({ title, items }: { title: string; items: readonly PrefItem<string>[] }) {
  return (
    <section className="p-1.5">
      <h3 className="px-2.5 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {items.map((item) => (
        <ToggleRow key={item.key} item={item} />
      ))}
    </section>
  );
}

export function SettingsMenu({ onOpenAccount, accountItemClassName, isTouch }: SettingsMenuProps) {
  const signedIn = useSignedIn();

  return (
    <HeaderPopover
      label="Beállítások"
      anchorToParent={isTouch}
      panelClassName={
        isTouch
          ? "inset-x-2 top-[calc(100%+2px)]"
          : "right-0 top-[calc(100%+14px)] w-[340px]"
      }
      renderTrigger={(trigger, isOpen) => {
        const button = (
          <button
            type="button"
            {...trigger}
            aria-label="Beállítások"
            className={cn(
              ICON_BUTTON,
              FOCUS_RING,
              isTouch ? "h-11 w-11" : "h-9 w-9",
              isOpen && "bg-accent text-foreground",
            )}
          >
            <Settings aria-hidden />
          </button>
        );
        if (isTouch) return button;
        return (
          <Tooltip>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="bottom">Beállítások</TooltipContent>
          </Tooltip>
        );
      }}
    >
      {(close) => (
        <>
          <div className="border-b border-border px-4 pb-2.5 pt-3">
            <p className="text-[13px] font-semibold text-foreground">Beállítások</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {signedIn ? <Cloud aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary" /> : <CloudOff aria-hidden className="h-3.5 w-3.5 shrink-0" />}
              {signedIn ? "Felhőbe szinkronizálva — minden eszközödön ugyanígy." : "Ezen az eszközön — bejelentkezve a felhőbe is szinkronizáljuk."}
            </p>
          </div>

          {/* Hosszú lista: a panel görgethető, a fejléc és a fiók-sor a helyén marad. */}
          <div className="max-h-[min(62vh,520px)] overflow-y-auto overscroll-contain">
            <Group title="Megállófigyelő" items={WATCH_FEATURES} />
            <div className="border-t border-border" />
            <Group title="Fejléc" items={HEADER_PREFS} />
            <LocationRow />
          </div>

          {onOpenAccount ? (
            <div className={cn("border-t border-border p-1.5", accountItemClassName)}>
              <button
                type="button"
                onClick={() => {
                  close();
                  onOpenAccount();
                }}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors duration-fast hover:bg-accent",
                  FOCUS_RING_INSET,
                )}
              >
                <UserRound aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-foreground">
                    Fiók és felhős mentés
                  </span>
                  <span className="block text-[11.5px] text-muted-foreground">
                    Kedvencek és beállítások szinkronizálása
                  </span>
                </span>
                <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            </div>
          ) : null}
        </>
      )}
    </HeaderPopover>
  );
}
