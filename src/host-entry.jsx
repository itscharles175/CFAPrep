// Host (CFA / Quant / Excel) app, lazy-loaded by the unified StudyVault root in
// main.jsx. Its static CSS imports live here so they only load on the host
// branch (the LSAT domain loads its own Tailwind world from LsatRoot) — and the
// style-isolation observer (lib/domainNav) attributes them to the host so they
// go inert while the LSAT domain is showing. (Plan S6.)
import { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import './styles/tokens.css';
// Unifies the shared cross-domain vocabulary (fonts) so /cfa and /lsat read as
// one product. Imported LAST + unlayered so it wins the cascade. (Plan S1.)
import './styles/unified-palette.css';
// KaTeX CSS bundled locally from npm — the strict-offline invariant forbids
// the cdn.jsdelivr.net `katex.min.css` that used to be linked from index.html.
import 'katex/dist/katex.min.css';
// K4-7: the one-time host startup now lives in a shared module so the unified
// root (flag-ON) runs the identical bootstraps. The behavior here is unchanged.
import { runHostStartupOnce } from './lib/hostStartup';

/** The host SPA (CFA/Quant/Excel) under its own router. Mounted by the unified
 *  StudyVault root when the URL is NOT under /lsat. Default export so
 *  React.lazy() can consume it directly (no `.then` re-export — rolldown, Vite
 *  8's bundler, didn't resolve the named-export wrapper form). */
export default function HostApp() {
  useEffect(() => {
    runHostStartupOnce();
  }, []);

  return (
    <BrowserRouter>
      <App />
    </BrowserRouter>
  );
}
