import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BookMarked,
  BookOpen,
  BrainCircuit,
  Clock,
  Database,
  Download,
  Flag,
  Library,
  ListMusic,
  RotateCcw,
  Settings,
  ShieldCheck,
  Target,
} from "lucide-react";

export interface RouteManifestEntry {
  path: string;
  label: string;
  commandLabel: string;
  group: "Practice" | "Insight" | "Setup" | "System";
  icon: LucideIcon;
  keywords: string[];
  hideInTest?: boolean;
  capability?: string;
  canonicalPath?: string;
}

export type AppMode = "study" | "test";

export const routeManifest: RouteManifestEntry[] = [
  {
    path: "/",
    label: "Notebook & Curriculum",
    commandLabel: "Go to Notebook & Curriculum",
    group: "Insight",
    icon: BookOpen,
    keywords: ["home", "notebook", "sources", "chat", "notes", "knowledge"],
    hideInTest: true,
    capability: "notebook_os",
  },
  {
    path: "/dashboard",
    label: "Study Overview",
    commandLabel: "Go to Study Overview",
    group: "Insight",
    icon: BarChart3,
    keywords: ["dashboard", "overview", "readiness", "analytics"],
    hideInTest: true,
  },
  { path: "/practice", label: "Practice", commandLabel: "Go to Practice", group: "Practice", icon: Clock, keywords: ["practice", "today"] },
  { path: "/preptests", label: "PrepTests", commandLabel: "Go to PrepTests", group: "Practice", icon: Library, keywords: ["exams", "tests"] },
  { path: "/drills", label: "Drills", commandLabel: "Go to Drills", group: "Practice", icon: Target, keywords: ["adaptive", "questions"] },
  { path: "/playlists", label: "Smart sets", commandLabel: "Go to Smart sets", group: "Practice", icon: ListMusic, keywords: ["playlists", "custom sets", "problem sets"] },
  { path: "/tutor", label: "Tutor", commandLabel: "Go to Tutor", group: "Insight", icon: BrainCircuit, keywords: ["socratic", "blind review", "why loop"], hideInTest: true },
  { path: "/notebook", label: "Notebook & Curriculum", commandLabel: "Go to Notebook & Curriculum", group: "Insight", icon: BookOpen, keywords: ["notebook", "curriculum", "wiki", "notes", "sources", "study sheet"], hideInTest: true, capability: "notebook_os", canonicalPath: "/" },
  { path: "/rc-lab", label: "RC Lab", commandLabel: "Go to RC Lab", group: "Insight", icon: BookMarked, keywords: ["reading comprehension", "passage maps"], hideInTest: true },
  { path: "/review", label: "Review", commandLabel: "Go to Review", group: "Insight", icon: Flag, keywords: ["blind review", "missed"], hideInTest: true },
  { path: "/review/history", label: "Session history", commandLabel: "Go to Session history", group: "Insight", icon: Clock, keywords: ["past", "compare", "history"], hideInTest: true },
  { path: "/srs", label: "SRS", commandLabel: "Go to SRS", group: "Insight", icon: RotateCcw, keywords: ["spaced repetition", "flashcards"], hideInTest: true },
  { path: "/analytics", label: "Analytics", commandLabel: "Go to Analytics", group: "Insight", icon: BarChart3, keywords: ["stats", "charts"], hideInTest: true },
  { path: "/bank", label: "Bank", commandLabel: "Go to Bank", group: "Setup", icon: Database, keywords: ["dataset", "questions", "content"], hideInTest: true },
  { path: "/content-ops", label: "Content Ops", commandLabel: "Go to Content Ops", group: "Setup", icon: ShieldCheck, keywords: ["trust", "validators", "scheduler"], hideInTest: true },
  { path: "/quarantine", label: "Quarantine", commandLabel: "Go to Quarantine", group: "Setup", icon: ShieldCheck, keywords: ["review", "gate"], hideInTest: true },
  { path: "/import", label: "Import", commandLabel: "Go to Import", group: "Setup", icon: Download, keywords: ["pdf", "source", "ingest"], hideInTest: true },
  { path: "/settings", label: "Settings", commandLabel: "Go to Settings", group: "Setup", icon: Settings, keywords: ["preferences", "models"] },
];

export const routePrefetchImporters: Record<string, () => Promise<unknown>> = {
  "/": () => import("@lsat/pages/Notebook"),
  "/dashboard": () => import("@lsat/pages/Dashboard"),
  "/practice": () => import("@lsat/pages/Practice"),
  "/preptests": () => import("@lsat/pages/PrepTests"),
  "/drills": () => import("@lsat/pages/Drills"),
  "/playlists": () => import("@lsat/pages/Playlists"),
  "/review": () => import("@lsat/pages/Review"),
  "/review/history": () => import("@lsat/pages/SessionHistory"),
  "/srs": () => import("@lsat/pages/Srs"),
  "/analytics": () => import("@lsat/pages/Analytics"),
  "/tutor": () => import("@lsat/pages/Tutor"),
  "/notebook": () => import("@lsat/pages/Notebook"),
  "/rc-lab": () => import("@lsat/pages/RcLab"),
  "/bank": () => import("@lsat/pages/Bank"),
  "/content-ops": () => import("@lsat/pages/ContentOps"),
  "/quarantine": () => import("@lsat/pages/Quarantine"),
  "/import": () => import("@lsat/pages/Import"),
  "/settings": () => import("@lsat/pages/Settings"),
};

const labels = new Map(routeManifest.map((entry) => [entry.path, entry.label]));

export function canonicalRoutePath(path: string): string {
  return routeManifest.find((entry) => entry.path === path)?.canonicalPath ?? path;
}

export function routeLabel(path: string): string | undefined {
  return labels.get(canonicalRoutePath(path));
}

export function routeCommandLabelFromManifest(path: string): string | undefined {
  return labels.get(canonicalRoutePath(path));
}

export function routeIsVisible(entry: RouteManifestEntry, mode: AppMode): boolean {
  return !(mode === "test" && entry.hideInTest);
}

export function visibleRouteManifest(mode: AppMode): RouteManifestEntry[] {
  return routeManifest.filter((entry) => routeIsVisible(entry, mode));
}

export function primaryRouteManifest(mode: AppMode): RouteManifestEntry[] {
  return visibleRouteManifest(mode).filter((entry) => !entry.canonicalPath);
}

export function manifestRoutesByGroup(mode: AppMode): Array<{
  group: RouteManifestEntry["group"];
  items: RouteManifestEntry[];
}> {
  const groups: RouteManifestEntry["group"][] = ["Practice", "Insight", "Setup", "System"];
  const visible = primaryRouteManifest(mode);
  return groups
    .map((group) => ({
      group,
      items: visible.filter((entry) => entry.group === group),
    }))
    .filter((section) => section.items.length > 0);
}
