import { useEffect } from "react";

/**
 * A tényleges látható magasság CSS-változóban.
 *
 * A `100vh` iOS-en a *legnagyobb* viewportot jelenti, a `100dvh` pedig nem
 * mindig frissül, amikor a lap altatásból tér vissza: ilyenkor a fejléc
 * felcsúszik és alul fekete sáv marad. A `visualViewport` mindig a valóban
 * látható területet adja, és minden ébredésre újramérünk.
 */
export function useAppHeight() {
  useEffect(() => {
    const apply = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-h", `${h}px`);
    };

    // Az ébredés utáni első festés még a régi méretet hozza, ezért kétszer
    // mérünk: azonnal, majd a következő képkockán.
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
