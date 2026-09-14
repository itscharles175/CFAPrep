import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { saveScroll, restoreScroll } from "@lsat/lib/scrollRestore";

/**
 * K4-13 — the LSAT shell as a layout route element.
 *
 * As of the final K4 cutover the LSAT App is ALWAYS mounted inside the host
 * <SharedLayout> (host Sidebar + TopBar + titlebar), so this shell is CHROMELESS:
 * it renders only the scrollable content region (with per-route scroll
 * save/restore via <MainScrollArea>) + the routed <Outlet/>. The legacy
 * full-chrome shell (its own Sidebar/header/mobile drawer/skip link) and the
 * `unified` dispatch were removed — SharedLayout supplies exactly one of each.
 * Mode/theme/providers are untouched (they live above this in
 * <LsatUnifiedMount>), so pages reading useMode()/useTheme() still work.
 */
export function AppShell() {
  const location = useLocation();
  return (
    <MainScrollArea pathname={location.pathname}>
      <Outlet />
    </MainScrollArea>
  );
}

function MainScrollArea({
  pathname,
  children,
}: {
  pathname: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const prevPath = useRef(pathname);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prevPath.current !== pathname) {
      saveScroll(prevPath.current, el.scrollTop);
      prevPath.current = pathname;
      requestAnimationFrame(() => {
        el.scrollTop = restoreScroll(pathname);
      });
    }
  }, [pathname]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => saveScroll(pathname, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [pathname]);

  return (
    <div
      ref={ref}
      id="main-content"
      className="scroll-thin flex-1 overflow-y-auto p-3 sm:p-6"
      role="region"
      aria-label="LSAT content"
      tabIndex={-1}
    >
      {children}
    </div>
  );
}
