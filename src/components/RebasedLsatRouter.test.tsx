/*
 * K4-7 regression guard — <RebasedLsatRouter> must let the LSAT App's own
 * `<Routes location={…}>` render as a TOP-LEVEL router even though the mount is
 * nested inside UnifiedRoot's `<Route path="/lsat/*">`.
 *
 * The cutover bug this guards: RebasedLsatRouter reset Navigation + Location
 * contexts but NOT RouteContext, so the parent match base stayed "/lsat" and RR
 * threw "the location pathname must begin with … the parent base '/lsat' but
 * pathname '/' was given" — blanking every /lsat page (caught only by an error
 * boundary showing "Could not load data"). The fix resets RouteContext too.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { RebasedLsatRouter, stripBasename } from './RebasedLsatRouter';

/** Stand-in for the vendored LSAT <App/>: it reads useLocation() (which the
 *  re-basing router strips to e.g. "/srs") and feeds it to its OWN
 *  `<Routes location={…}>` with absolute paths — exactly the pattern that threw
 *  the invariant before the RouteContext reset. */
function InnerLsatRoutes() {
  const location = useLocation();
  return (
    <Routes location={location}>
      <Route path="/" element={<div>lsat-home</div>} />
      <Route path="/srs" element={<div>lsat-srs</div>} />
    </Routes>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {/* Mirror UnifiedRoot: the LSAT plane is the element of a /lsat/* route,
            so the parent matched pathname base is "/lsat". */}
        <Route
          path="/lsat/*"
          element={
            <RebasedLsatRouter>
              <InnerLsatRoutes />
            </RebasedLsatRouter>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RebasedLsatRouter', () => {
  it('renders a descendant <Routes location> for a deep /lsat/* URL without throwing', () => {
    renderAt('/lsat/srs');
    // Before the RouteContext reset this threw the "pathname base is /lsat" invariant.
    expect(screen.getByText('lsat-srs')).toBeInTheDocument();
  });

  it('strips the /lsat base so the bare /lsat URL maps to the LSAT App root "/"', () => {
    renderAt('/lsat');
    expect(screen.getByText('lsat-home')).toBeInTheDocument();
  });

  describe('stripBasename', () => {
    it('removes the basename and yields "/" at the base', () => {
      expect(stripBasename('/lsat', '/lsat')).toBe('/');
      expect(stripBasename('/lsat/', '/lsat')).toBe('/');
    });
    it('removes the basename for deeper paths', () => {
      expect(stripBasename('/lsat/srs', '/lsat')).toBe('/srs');
      expect(stripBasename('/lsat/practice/run', '/lsat')).toBe('/practice/run');
    });
    it('returns null when the path is not under the basename', () => {
      expect(stripBasename('/cfa/equity', '/lsat')).toBeNull();
      // "/lsational" must NOT be treated as under "/lsat".
      expect(stripBasename('/lsational', '/lsat')).toBeNull();
    });
  });
});
