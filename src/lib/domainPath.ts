export type Domain = 'host' | 'lsat';

export function isLsatPath(pathname: string): boolean {
  return pathname === '/lsat' || pathname.startsWith('/lsat/');
}

export function domainForPath(pathname: string): Domain {
  return isLsatPath(pathname) ? 'lsat' : 'host';
}
