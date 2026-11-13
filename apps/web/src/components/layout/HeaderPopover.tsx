import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { PANEL_SURFACE } from "./headerStyles";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ENTER_EASE = [0.22, 1, 0.36, 1] as const;

export interface PopoverTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  "aria-haspopup": "dialog";
}

interface HeaderPopoverProps {
  /** A panel akadálymentes neve. */
  label: string;
  renderTrigger: (trigger: PopoverTriggerProps, isOpen: boolean) => ReactNode;
  /** A panel tartalma; a `close` visszaadja a fókuszt a triggernek. */
  children: (close: () => void) => ReactNode;
  /** Pozíció és méret  a legközelebbi `relative` őshöz képest. */
  panelClassName: string;
  /**
   * Igaz: a panel nem a triggerhez, hanem egy távolabbi `relative` őshöz
   * (pl. a mobil felső sávhoz) igazodik, így keskeny kijelzőn sem lóg ki.
   */
  anchorToParent?: boolean;
  transformOrigin?: string;
  /** A burkoló elem osztályai (pl. `min-w-0`, hogy flex-sorban zsugorodhasson). */
  className?: string;
}

/**
 * Kis, akadálymentes lenyíló panel a fejléchez (nincs Radix Popover a
 * projektben). Kattintás kívülre vagy Escape bezárja; megnyitáskor az első
 * vezérlőre, bezáráskor vissza a triggerre kerül a fókusz.
 */
export function HeaderPopover({
  label,
  renderTrigger,
  children,
  panelClassName,
  anchorToParent = false,
  transformOrigin = "top right",
  className,
}: HeaderPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const reduceMotion = useReducedMotion();

  const close = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const isInside = (node: Node | null) =>
      !!node &&
      (panelRef.current?.contains(node) || triggerRef.current?.contains(node));

    const handlePointerDown = (e: PointerEvent) => {
      if (!isInside(e.target as Node)) setIsOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus({ preventScroll: true });

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, close]);

  // Tabbal kilépve a panelből bezárunk; ha a fókusz „sehová” megy (pl. Safari
  // gombkattintás), azt a pointerdown-figyelő kezeli.
  const handleBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (!next) return;
    if (panelRef.current?.contains(next) || triggerRef.current?.contains(next)) {
      return;
    }
    setIsOpen(false);
  };

  const hidden = reduceMotion
    ? { opacity: 0 }
    : { opacity: 0, y: -4, scale: 0.98 };

  return (
    <div className={cn(!anchorToParent && "relative", className)}>
      {renderTrigger(
        {
          ref: triggerRef,
          onClick: () => setIsOpen((v) => !v),
          "aria-expanded": isOpen,
          "aria-controls": isOpen ? panelId : undefined,
          "aria-haspopup": "dialog",
        },
        isOpen,
      )}
      <AnimatePresence>
        {isOpen ? (
          <motion.div
            key="panel"
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            initial={hidden}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={hidden}
            transition={{ duration: 0.14, ease: ENTER_EASE }}
            style={{ transformOrigin }}
            onBlur={handleBlur}
            className={cn("absolute z-50 outline-none", PANEL_SURFACE, panelClassName)}
          >
            {children(close)}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
