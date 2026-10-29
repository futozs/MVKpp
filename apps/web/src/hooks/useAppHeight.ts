import { useEffect } from "react";

export function useAppHeight() {
  useEffect(() => {
    const apply = () => {
      // Nagyításkor a visualViewport.height 1/scale arányban zsugorodik — a
      // skálával visszaszorozva a magasság marad, a billentyűzet viszont
      // (scale = 1 mellett) továbbra is csökkenti. Kicsinyített nézetben (iPad
      // Safari oldalnagyítás / asztali mód: scale < 1) a látható terület épp
      // vv.height — ott szorozni nem szabad, különben az app csak ~75%-ot tölt ki.
      const vv = window.visualViewport;
      const h = vv ? Math.round(vv.height * Math.max(1, vv.scale)) : window.innerHeight;
      // iOS-en a billentyűzet nyitásakor az oldal fel is gördül (offsetTop):
      // az app a látható terület tetejéhez igazodik, különben alul üres sáv
      // marad. Nagyítás közbeni görgetést nem követünk.
      const top = vv && vv.scale < 1.01 ? Math.max(0, Math.round(vv.offsetTop)) : 0;
      const root = document.documentElement.style;
      root.setProperty("--app-h", `${h}px`);
      root.setProperty("--app-top", `${top}px`);
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
