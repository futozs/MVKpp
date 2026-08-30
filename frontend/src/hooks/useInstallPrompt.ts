import { useCallback, useEffect, useState } from "react";

/**
 * A Chrome `beforeinstallprompt` eseménye — a típus még nem része a
 * lib.dom.d.ts-nek, ezért itt írjuk le.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "mvk_install_dismissed";

/** Az iOS Safari nem ad telepítési eseményt — ott kézi útmutató kell. */
function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS asztali módban Mac-nek adja ki magát, de van érintése.
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // Az iOS saját, szabványon kívüli jelzése.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export interface InstallState {
  /** Megjeleníthető-e egyáltalán a telepítési ajánlat. */
  canOffer: boolean;
  /** Nincs natív prompt: iOS-en lépésről lépésre kell elmondani. */
  needsManualSteps: boolean;
  installed: boolean;
  /** A natív telepítőpárbeszéd megnyitása. */
  install: () => Promise<void>;
  dismiss: () => void;
}

export function useInstallPrompt(): InstallState {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [installed, setInstalled] = useState(isStandalone);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      // A böngésző saját mini-sávja helyett a saját, magyar nyelvű ajánlatunk
      // jelenik meg — ezért fogjuk el az eseményt.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    if (outcome === "accepted") setInstalled(true);
  }, [deferred]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {}
  }, []);

  const manual = isIos() && !installed;

  return {
    canOffer: !installed && !dismissed && (Boolean(deferred) || manual),
    needsManualSteps: !deferred && manual,
    installed,
    install,
    dismiss,
  };
}
