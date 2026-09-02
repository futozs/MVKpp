import { useEffect } from "react";

export function useAppHeight() {
  useEffect(() => {
    const apply = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-h", `${h}px`);
    };

    const applySoon = () => {
      apply();
      requestAnimationFrame(apply);
      setTimeout(apply, 250);
    };

    apply();

    const vv = window.visualViewport;
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", applySoon);
    window.addEventListener("pageshow", applySoon);
    window.addEventListener("focus", applySoon);
    document.addEventListener("visibilitychange", applySoon);

    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", applySoon);
      window.removeEventListener("pageshow", applySoon);
      window.removeEventListener("focus", applySoon);
      document.removeEventListener("visibilitychange", applySoon);
    };
  }, []);
}
