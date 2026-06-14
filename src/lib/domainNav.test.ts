import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOMAIN_NAV_EVENT,
  domainForPath,
  isLsatPath,
  navigateDomain,
  setActiveDomain,
  startStyleIsolation,
} from './domainNav';

function makeSheet(domain?: string): HTMLStyleElement {
  const el = document.createElement('style');
  if (domain) el.setAttribute('data-sv-domain', domain);
  document.head.appendChild(el);
  return el;
}

afterEach(() => {
  document.head
    .querySelectorAll('style[data-sv-domain], link[data-sv-domain]')
    .forEach((e) => e.remove());
});

describe('path helpers', () => {
  it('isLsatPath matches /lsat and /lsat/* only', () => {
    expect(isLsatPath('/lsat')).toBe(true);
    expect(isLsatPath('/lsat/analytics')).toBe(true);
    expect(isLsatPath('/')).toBe(false);
    expect(isLsatPath('/cfa')).toBe(false);
    expect(isLsatPath('/lsatfoo')).toBe(false); // not a false-positive prefix
  });

  it('domainForPath maps to host/lsat', () => {
    expect(domainForPath('/lsat/x')).toBe('lsat');
    expect(domainForPath('/quant')).toBe('host');
    expect(domainForPath('/')).toBe('host');
  });
});

describe('setActiveDomain — CSS isolation toggling', () => {
  it('disables the other domain’s sheets, enables the active one (round-trip)', () => {
    const host = makeSheet('host');
    const lsat = makeSheet('lsat');

    setActiveDomain('lsat');
    expect(host.disabled).toBe(true); // host CSS inert while LSAT shows
    expect(lsat.disabled).toBe(false);

    // The round-trip case that broke the naive merge: back to host must restore
    // the host's stylesheet (so its dark palette isn't left clobbered).
    setActiveDomain('host');
    expect(host.disabled).toBe(false);
    expect(lsat.disabled).toBe(true);
  });

  it('never disables untagged (shared base) sheets', () => {
    const shared = document.createElement('style');
    document.head.appendChild(shared);
    setActiveDomain('lsat');
    expect(shared.disabled).toBe(false);
    shared.remove();
  });
});

describe('startStyleIsolation — observer attribution', () => {
  it('stamps a newly injected sheet with the active domain', async () => {
    startStyleIsolation('host');
    const s = makeSheet(); // untagged; the observer should attribute it
    await new Promise((r) => setTimeout(r, 0)); // flush the MutationObserver
    expect(s.getAttribute('data-sv-domain')).toBe('host');
  });
});

describe('navigateDomain — soft cross-domain hop', () => {
  it('pushes the URL, emits the nav event, and pre-isolates CSS', () => {
    const host = makeSheet('host');
    const onNav = vi.fn();
    window.addEventListener(DOMAIN_NAV_EVENT, onNav);

    navigateDomain('/lsat/analytics');

    expect(window.location.pathname).toBe('/lsat/analytics');
    expect(onNav).toHaveBeenCalledTimes(1);
    expect(host.disabled).toBe(true); // setActiveDomain('lsat') applied before paint

    window.removeEventListener(DOMAIN_NAV_EVENT, onNav);
    // restore for other suites
    window.history.pushState({}, '', '/');
  });

  it('no-ops when already at the target URL', () => {
    window.history.pushState({}, '', '/today');
    const onNav = vi.fn();
    window.addEventListener(DOMAIN_NAV_EVENT, onNav);
    navigateDomain('/today');
    expect(onNav).not.toHaveBeenCalled();
    window.removeEventListener(DOMAIN_NAV_EVENT, onNav);
    window.history.pushState({}, '', '/');
  });
});
