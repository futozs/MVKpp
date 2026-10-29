import { useEffect } from "react";

export function useAppHeight() {
  useEffect(() => {
    const apply = () => {
      // Nagyításkor a visualViewport.height 1/scale arányban zsugorodik — a
      // skálával visszaszorozva a magasság marad, a billentyűzet viszont
      // (scale = 1 mellett) továbbra is csökkenti.
      const vv = window.visualViewport;
      const h = vv ? Math.round(vv.height * vv.scale) : window.innerHeight;
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
