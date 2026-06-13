/**
 * Ambient shim for the vendored LSAT domain.
 *
 * The host's strict `tsc` follows `main.jsx`'s dynamic import into
 * `src/domains/lsat/LsatRoot.tsx`, whose imports use the `@lsat/*` alias. We
 * deliberately do NOT type-check the vendored React-18/TS-5.6 subtree under the
 * host's strict config (it has its own toolchain conventions). Declaring
 * `@lsat/*` as an ambient module makes tsc resolve those imports to `any` and
 * stop there — so the subtree is never pulled into the host program — while
 * Vite/esbuild still bundles the real files via the `@lsat` resolve.alias.
 *
 * Type-safety inside the LSAT subtree is owned by its own tooling, not the host.
 */
declare module '@lsat/*';
