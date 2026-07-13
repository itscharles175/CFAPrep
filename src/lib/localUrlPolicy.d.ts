export class LocalUrlPolicyError extends Error {}

export function isLoopbackHostname(hostname: unknown): boolean;

export function normalizeLoopbackHttpBaseUrl(value: unknown, label?: string): string;

export function buildLoopbackHttpUrl(
  baseUrl: unknown,
  path: unknown,
  label?: string,
): string;
