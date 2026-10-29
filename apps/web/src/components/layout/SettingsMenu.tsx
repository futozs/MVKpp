import { useId } from "react";
import { ChevronRight, Settings, UserRound } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PREF_PREDICTED_VEHICLE, usePreference } from "@/hooks/usePreference";
import { cn } from "@/lib/utils";
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

export function SettingsMenu({ onOpenAccount, accountItemClassName, isTouch }: SettingsMenuProps) {
  const [showPredicted, setShowPredicted] = usePreference(PREF_PREDICTED_VEHICLE, true);
  const switchId = useId();
  const descriptionId = useId();

  return (
    <HeaderPopover
      label="Beállítások"
      anchorToParent={isTouch}
      panelClassName={
        isTouch
          ? "inset-x-2 top-[calc(100%+2px)]"
          : "right-0 top-[calc(100%+14px)] w-80"
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
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Ezen az eszközön tárolva — a felhős mentés is viszi.
            </p>
          </div>

          <div className="p-1.5">
            <div className="flex items-start gap-3 rounded-md px-2.5 py-2.5">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor={switchId}
                  className="block cursor-pointer text-sm font-semibold text-foreground"
                >
                  Rendszám-előrejelzés
                </label>
                <p
                  id={descriptionId}
                  className="mt-1 text-[11.5px] leading-snug text-muted-foreground"
                >
                  Mielőtt a busz élőben megjelenne, a várható rendszámát{" "}
                  <span className="font-mono font-bold text-primary">~</span> jellel
                  mutatjuk — a korábbi járműfordák alapján.
                </p>
              </div>
              <Switch
                id={switchId}
                checked={showPredicted}
                onCheckedChange={setShowPredicted}
                aria-describedby={descriptionId}
                // A 20 px-es kapcsoló érintési felülete 44 px-re bővítve.
                className="relative mt-0.5 after:absolute after:-inset-3 after:content-[''] focus-visible:ring-offset-popover"
              />
            </div>
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
