import type { Recommendation } from "./types";

function payloadValue(payload: Record<string, unknown> | undefined, key: string) {
  const value = payload?.[key];
  return value == null || value === "" ? undefined : String(value);
}

function withParam(path: string, key: string, value?: string) {
  if (!value) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${key}=${encodeURIComponent(value)}`;
}

export function routeForRecommendation(
  recommendation: Recommendation | null | undefined,
): string {
  const action = recommendation?.action;
  const payload = action?.payload ?? {};
  const qType = payloadValue(payload, "q_type");

  switch (action?.type) {
    case "drill":
    case "start_drill":
      return withParam("/drills", "q_type", qType);
    case "srs":
      return "/srs";
    case "blind_review":
      return withParam("/review?tab=buckets", "q_type", qType);
    case "analytics": {
      const view = payloadValue(payload, "view");
      const tab =
        view === "traps" ? "traps" :
        view === "timing" ? "timing" :
        view === "difficulty" ? "difficulty" :
        view === "gap" || view === "calibration" ? "gap" :
        "type";
      return withParam(`/analytics?tab=${tab}`, "q_type", qType);
    }
    case "start_section":
      return "/practice";
    default:
      return withParam("/drills", "q_type", qType);
  }
}
