import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import {
  AudioLines,
  BookOpen,
  BrainCircuit,
  Download,
  FileInput,
  FileText,
  Link,
  MessageSquareText,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import { PageLayout, PageSection } from "@lsat/components/page-layout";
import { ActivityCenter } from "@lsat/components/notebook-os/activity-center";
import { CitationChip } from "@lsat/components/notebook-os/citation-chip";
import { ContextToggle } from "@lsat/components/notebook-os/context-toggle";
import { EvidencePanel } from "@lsat/components/notebook-os/evidence-panel";
import { SourceStatusPill } from "@lsat/components/notebook-os/source-status-pill";
// K4-10 — host-styled primitive swap (chrome only). These six render the host
// `.qv-*`/`.btn`/`.badge` vocabulary and are verified drop-in for the props this
// page passes; behaviour, structure, and a11y markup are unchanged. `icon`,
// `switch`, `textarea`, and the `page-layout` / `notebook-os` feature components
// have no host-barrel equivalent and stay on `@lsat`.
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@lsat/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Switch } from "@lsat/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@lsat/components/ui/textarea";
import { api } from "@lsat/lib/api";
import {
  useArtifactVersions,
  useBacklinks,
  useContextPresets,
  useKnowledgeInbox,
  useNotebookCapabilities,
  useNotebookActivity,
  useNotebookChatSessions,
  useNotebookNotes,
  useNotebookPages,
  useNotebookSearch,
  useNotebookSources,
  usePodcasts,
  useTransformations,
  useWorkspaceDefault,
} from "@lsat/lib/hooks";
import {
  DEFAULT_NOTEBOOK_CAPABILITIES,
  enabledCapabilities,
} from "@lsat/lib/notebookCapabilities";
import type {
  CitationTarget,
  ContextMode,
  NotebookChatMessage,
  NotebookExportBundle,
  NotebookNote,
} from "@lsat/lib/types";
type NotebookExportFormat = NotebookExportBundle["format"];
type NotebookImportFormat = "auto" | "json" | "markdown" | "html";

function humanize(value: string) {
  return value.split("_").join(" ");
}

function citationFromRaw(raw: string | Record<string, unknown>): CitationTarget {
  if (typeof raw === "string") {
    return {
      target: raw,
      label: raw,
      target_kind: raw.split(":")[0],
      official_firewall: false,
    };
  }
  const target = String(raw.target ?? "");
  return {
    target,
    label: String(raw.label ?? target),
    target_kind: String(raw.target_kind ?? target.split(":")[0]),
    official_firewall: Boolean(raw.official_firewall),
  };
}

function artifactIdFromTarget(target?: string) {
  if (!target?.startsWith("artifact:")) return null;
  const id = Number(target.slice("artifact:".length));
  return Number.isFinite(id) ? id : null;
}

function extensionForExport(format: NotebookExportFormat) {
  if (format === "html") return "html";
  if (format === "json") return "json";
  return "md";
}

export default function Notebook() {
  const qc = useQueryClient();
  const location = useLocation();
  const workspace = useWorkspaceDefault();
  const capabilitiesQuery = useNotebookCapabilities();
  const sourcesQuery = useNotebookSources();
  const notesQuery = useNotebookNotes();
  const activityQuery = useNotebookActivity();
  const inboxQuery = useKnowledgeInbox();
  const sessionsQuery = useNotebookChatSessions();
  const transformsQuery = useTransformations();
  const podcastsQuery = usePodcasts();
  const presetsQuery = useContextPresets();
  const pagesQuery = useNotebookPages();

  const [query, setQuery] = useState("");
  const searchQuery = useNotebookSearch(query);
  const [contextMode, setContextMode] = useState<ContextMode>("summary");
  const [activeCitation, setActiveCitation] = useState<CitationTarget | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);

  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceType, setSourceType] = useState("auto");
  const [sourceContent, setSourceContent] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceOfficialFirewall, setSourceOfficialFirewall] = useState(false);
  const [bundleFile, setBundleFile] = useState<File | null>(null);
  const [bundleFormat, setBundleFormat] = useState<NotebookImportFormat>("auto");
  const [bundleOfficialFirewall, setBundleOfficialFirewall] = useState(false);

  const [noteTitle, setNoteTitle] = useState("");
  const [noteType, setNoteType] = useState("manual");
  const [noteContent, setNoteContent] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [template, setTemplate] = useState("summarize");
  const [exportFormat, setExportFormat] = useState<NotebookExportFormat>("markdown");
  const capabilities =
    capabilitiesQuery.data?.data ?? DEFAULT_NOTEBOOK_CAPABILITIES;
  const sourceTypeOptions = useMemo(
    () => enabledCapabilities(capabilities.source_types),
    [capabilities.source_types],
  );
  const noteTypeOptions = useMemo(
    () => enabledCapabilities(capabilities.note_types),
    [capabilities.note_types],
  );
  const transformTemplateOptions = useMemo(
    () => enabledCapabilities(capabilities.transform_templates),
    [capabilities.transform_templates],
  );
  const exportFormatOptions = useMemo(
    () => enabledCapabilities(capabilities.export_formats),
    [capabilities.export_formats],
  );
  const importFormatOptions = useMemo(
    () =>
      enabledCapabilities(
        capabilities.import_formats ?? DEFAULT_NOTEBOOK_CAPABILITIES.import_formats ?? [],
      ),
    [capabilities.import_formats],
  );
  const contextModeOptions = useMemo(
    () => enabledCapabilities(capabilities.context_modes),
    [capabilities.context_modes],
  );
  const activeArtifactId = artifactIdFromTarget(activeCitation?.target);
  const backlinksQuery = useBacklinks(activeCitation?.target ?? null);
  const versionsQuery = useArtifactVersions(activeArtifactId);
  const activeArtifactQuery = useQuery({
    queryKey: ["evidence-artifact", activeArtifactId],
    queryFn: () =>
      activeArtifactId ? api.evidenceArtifact(activeArtifactId) : Promise.resolve(null),
    enabled: Boolean(activeArtifactId),
  });

  const sources = sourcesQuery.data?.data ?? [];
  const notes = notesQuery.data?.data ?? [];
  const activity = activityQuery.data?.data ?? [];
  const inbox = inboxQuery.data?.data ?? [];
  const rawSessions = sessionsQuery.data?.data;
  const sessions = useMemo(() => rawSessions ?? [], [rawSessions]);
  const transforms = transformsQuery.data?.data ?? [];
  const podcasts = podcastsQuery.data?.data ?? [];
  const presets = presetsQuery.data?.data ?? [];
  const pages = pagesQuery.data?.data ?? [];
  const search = searchQuery.data?.data;
  const backlinks = backlinksQuery.data?.data ?? [];
  const versions = versionsQuery.data?.data ?? [];
  const activeArtifact = activeArtifactQuery.data ?? null;
  useEffect(() => {
    if (!activeSessionId && sessions.length) {
      setActiveSessionId(sessions[0].id);
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    const state = location.state as { quickCapture?: string } | null;
    if (state?.quickCapture && !noteContent) {
      setNoteTitle("Quick capture");
      setNoteType("captured");
      setNoteContent(state.quickCapture);
    }
  }, [location.state, noteContent]);

  useEffect(() => {
    if (
      sourceTypeOptions.length &&
      !sourceTypeOptions.some((option) => option.value === sourceType)
    ) {
      setSourceType(sourceTypeOptions[0].value);
    }
  }, [sourceType, sourceTypeOptions]);

  useEffect(() => {
    if (
      noteTypeOptions.length &&
      !noteTypeOptions.some((option) => option.value === noteType)
    ) {
      setNoteType(noteTypeOptions[0].value);
    }
  }, [noteType, noteTypeOptions]);

  useEffect(() => {
    if (
      transformTemplateOptions.length &&
      !transformTemplateOptions.some((option) => option.value === template)
    ) {
      setTemplate(transformTemplateOptions[0].value);
    }
  }, [template, transformTemplateOptions]);

  useEffect(() => {
    if (
      exportFormatOptions.length &&
      !exportFormatOptions.some((option) => option.value === exportFormat)
    ) {
      setExportFormat(exportFormatOptions[0].value);
    }
  }, [exportFormat, exportFormatOptions]);

  useEffect(() => {
    if (
      contextModeOptions.length &&
      !contextModeOptions.some((option) => option.value === contextMode)
    ) {
      setContextMode(contextModeOptions[0].value);
    }
  }, [contextMode, contextModeOptions]);

  const messagesQuery = useQuery({
    queryKey: ["notebook-chat-messages", activeSessionId],
    queryFn: () => (activeSessionId ? api.notebookChatMessages(activeSessionId) : Promise.resolve([])),
    enabled: Boolean(activeSessionId),
  });
  const messages = messagesQuery.data ?? [];
  const workbenchQueries = [
    workspace,
    capabilitiesQuery,
    sourcesQuery,
    notesQuery,
    activityQuery,
    inboxQuery,
    sessionsQuery,
    transformsQuery,
    podcastsQuery,
    presetsQuery,
    pagesQuery,
  ];
  const usingSample = workbenchQueries.some((item) => item.data?.usingSample);
  const hasQueryError =
    workbenchQueries.some((item) => item.isError) ||
    messagesQuery.isError ||
    searchQuery.isError ||
    backlinksQuery.isError ||
    versionsQuery.isError ||
    activeArtifactQuery.isError;
  const hasRunningActivity = activity.some((event) =>
    ["running", "queued", "pending"].includes(event.status),
  );
  const workbenchStatus = hasQueryError
    ? "failed"
    : usingSample
      ? "offline"
      : hasRunningActivity
        ? "running"
        : "ready";

  const activeRefs = useMemo(
    () => (activeCitation ? [activeCitation.target] : []),
    [activeCitation],
  );
  const hasSourcePayload = Boolean(
    sourceContent.trim() || sourceUrl.trim() || sourceFile || activeRefs.length,
  );
  const canAddSource = Boolean(sourceTitle.trim() && hasSourcePayload);

  async function refreshWorkbench() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["notebook-sources"] }),
      qc.invalidateQueries({ queryKey: ["notebook-capabilities"] }),
      qc.invalidateQueries({ queryKey: ["notebook-notes"] }),
      qc.invalidateQueries({ queryKey: ["notebook-activity"] }),
      qc.invalidateQueries({ queryKey: ["knowledge-inbox"] }),
      qc.invalidateQueries({ queryKey: ["notebook-chat-sessions"] }),
      qc.invalidateQueries({ queryKey: ["notebook-chat-messages"] }),
      qc.invalidateQueries({ queryKey: ["transformations"] }),
      qc.invalidateQueries({ queryKey: ["podcasts"] }),
      qc.invalidateQueries({ queryKey: ["notebook-search"] }),
      qc.invalidateQueries({ queryKey: ["backlinks"] }),
      qc.invalidateQueries({ queryKey: ["artifact-versions"] }),
    ]);
  }

  function selectArtifact(target: string, label: string, official_firewall = false) {
    setActiveCitation({
      target,
      label,
      official_firewall,
      target_kind: target.split(":")[0],
    });
  }

  async function addSource() {
    if (!canAddSource) return;
    await api.importNotebookSource({
      title: sourceTitle,
      source_type: sourceType,
      content: sourceContent,
      url: sourceUrl,
      file: sourceFile,
      provider: "local",
      refs: activeRefs,
      official_firewall: sourceOfficialFirewall,
    });
    setSourceTitle("");
    setSourceContent("");
    setSourceUrl("");
    setSourceFile(null);
    setSourceOfficialFirewall(false);
    await refreshWorkbench();
    toast.success("Source added");
  }

  function editNote(note: NotebookNote) {
    setEditingNoteId(note.id);
    setNoteTitle(note.title);
    setNoteType(note.note_type);
    setNoteContent(note.content);
    if (note.artifact_id) {
      selectArtifact(`artifact:${note.artifact_id}`, note.title);
    }
  }

  function resetNoteEditor() {
    setEditingNoteId(null);
    setNoteTitle("");
    setNoteContent("");
    setNoteType("manual");
  }

  async function addNote() {
    if (!noteTitle.trim()) return;
    if (editingNoteId) {
      await api.updateNotebookNote(editingNoteId, {
        title: noteTitle,
        note_type: noteType,
        content: noteContent,
        citations: activeRefs,
      });
      toast.success("Note updated");
    } else {
      await api.createNotebookNote({
        title: noteTitle,
        note_type: noteType,
        content: noteContent,
        citations: activeRefs,
      });
      toast.success("Note saved");
    }
    resetNoteEditor();
    await refreshWorkbench();
  }

  async function ensureChatSession() {
    if (activeSessionId) return activeSessionId;
    const session = await api.createNotebookChatSession({
      title: "Notebook tutor",
      mode: contextMode,
      model: "local",
      context: { refs: activeRefs },
    });
    setActiveSessionId(session.id);
    await qc.invalidateQueries({ queryKey: ["notebook-chat-sessions"] });
    return session.id;
  }

  async function sendMessage() {
    if (!chatInput.trim()) return;
    const sessionId = await ensureChatSession();
    await api.sendNotebookChatMessage(sessionId, {
      content: chatInput,
      mode: contextMode,
      refs: activeRefs,
    });
    setChatInput("");
    await refreshWorkbench();
    await qc.invalidateQueries({ queryKey: ["notebook-chat-messages", sessionId] });
  }

  async function runTransform() {
    const result = await api.runTransformation({
      template_key: template,
      provider: "local",
      model: "local",
      input_refs: activeRefs,
    });
    if (result.output_artifact_id) {
      selectArtifact(
        `artifact:${result.output_artifact_id}`,
        humanize(result.template_key),
        Boolean(result.firewall_decision?.official_firewall),
      );
    }
    await refreshWorkbench();
    toast.success(`${humanize(result.template_key)} complete`);
  }

  async function makePodcast() {
    const result = await api.createPodcast({
      title: "Notebook study briefing",
      episode_type: "weekly_briefing",
      provider: "local",
      source_refs: activeRefs,
      generate_audio: true,
    });
    await refreshWorkbench();
    toast.success(
      result.status === "audio_ready"
        ? `${result.title} audio ready`
        : `${result.title} transcript ready`,
    );
  }

  async function saveMessageAsNote(message: NotebookChatMessage) {
    await api.createNotebookNote({
      title: `Tutor turn ${new Date(message.created_at).toLocaleString()}`,
      note_type: "captured",
      content: message.content,
      citations: message.citations,
    });
    await refreshWorkbench();
    toast.success("Tutor turn saved as a note");
  }

  async function savePodcastAsNote(episode: {
    title: string;
    transcript: string;
    source_refs: Array<string | Record<string, unknown>>;
  }) {
    await api.createNotebookNote({
      title: episode.title,
      note_type: "transformed",
      content: episode.transcript,
      citations: episode.source_refs,
    });
    await refreshWorkbench();
    toast.success("Briefing transcript saved as a note");
  }

  async function exportNotebook() {
    const result = await api.exportNotebook({
      title: activeCitation ? `${activeCitation.label} export` : "LSATLab Notebook Export",
      format: exportFormat,
      refs: activeRefs,
    });
    const body =
      typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body, null, 2);
    const blob = new Blob([body], { type: result.content_type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${
      result.title.replace(/[^\w.-]+/g, "-").toLowerCase() || "notebook-export"
    }.${extensionForExport(result.format)}`;
    link.click();
    URL.revokeObjectURL(url);
    await refreshWorkbench();
    toast.success(
      result.redacted_count
        ? `Export ready with ${result.redacted_count} redacted item${result.redacted_count === 1 ? "" : "s"}`
        : "Export ready",
    );
  }

  async function importBundle() {
    if (!bundleFile) return;
    const content = await bundleFile.text();
    const result = await api.importNotebookBundle({
      title: bundleFile.name.replace(/\.[^.]+$/, "") || "Imported notebook bundle",
      format: bundleFormat,
      content,
      provider: "local",
      official_firewall: bundleOfficialFirewall,
      tags: ["notebook-import"],
    });
    setBundleFile(null);
    setBundleFormat("auto");
    setBundleOfficialFirewall(false);
    await refreshWorkbench();
    toast.success(
      `Imported ${result.created.sources} source${result.created.sources === 1 ? "" : "s"} and ${result.created.notes} note${result.created.notes === 1 ? "" : "s"}`,
    );
  }

  async function updateInboxItem(
    id: number,
    patch: { status?: string; priority?: number },
  ) {
    await api.updateKnowledgeInboxItem(id, patch);
    await refreshWorkbench();
    toast.success(patch.status === "resolved" ? "Inbox item resolved" : "Inbox item updated");
  }

  return (
    <PageLayout
      title="Notebook OS"
      eyebrow={workspace.data?.data.key ?? "local workspace"}
      icon={BookOpen}
      width="full"
      description={workspace.data?.data.description || "Sources, notes, tutor chat, citations, and local-first study transformations."}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <SourceStatusPill status={workbenchStatus} official={Boolean(activeCitation?.official_firewall)} />
          <Button size="sm" variant="outline" onClick={runTransform}>
            <Sparkles className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Transform</span>
          </Button>
          <Button size="sm" variant="outline" onClick={makePodcast}>
            <AudioLines className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Briefing</span>
          </Button>
          <Select
            value={exportFormat}
            onValueChange={(value) => setExportFormat(value as NotebookExportFormat)}
          >
            <SelectTrigger className="h-9 w-32" aria-label="Export format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {exportFormatOptions.map((format) => (
                <SelectItem key={format.value} value={format.value}>
                  {format.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={exportNotebook}>
            <Download className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Export</span>
          </Button>
        </div>
      }
    >
      {(usingSample || hasQueryError) && (
        <div
          role="status"
          className={
            hasQueryError
              ? "mb-4 rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm text-destructive"
              : "mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
          }
        >
          {hasQueryError
            ? "Notebook OS could not load current backend evidence. Actions may fail until the backend recovers."
            : "Notebook OS is showing offline fallback data until the backend responds."}
        </div>
      )}
      <div className="grid min-h-[calc(100vh-13rem)] gap-4 xl:grid-cols-[300px_minmax(0,1fr)_340px]">
        <aside className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Icon as={FileInput} size="sm" />
                Sources
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                value={sourceTitle}
                onChange={(event) => setSourceTitle(event.target.value)}
                placeholder="Source title"
                aria-label="Source title"
              />
              <Select value={sourceType} onValueChange={setSourceType}>
                <SelectTrigger aria-label="Source type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sourceTypeOptions.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Textarea
                value={sourceContent}
                onChange={(event) => setSourceContent(event.target.value)}
                className="min-h-28"
                placeholder="Paste text, transcript, or source notes"
                aria-label="Source content"
              />
              <div className="grid gap-2">
                <div className="relative">
                  <Link className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={sourceUrl}
                    onChange={(event) => setSourceUrl(event.target.value)}
                    className="pl-9"
                    placeholder="https:// research URL"
                    aria-label="Source URL"
                  />
                </div>
                <Input
                  type="file"
                  accept=".txt,.md,.markdown,.pdf,.docx,.vtt,.srt,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={(event) => setSourceFile(event.target.files?.[0] ?? null)}
                  aria-label="Upload source file"
                />
                {sourceFile && (
                  <p className="truncate text-xs text-muted-foreground">
                    {sourceFile.name}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border bg-surface-1 px-3 py-2">
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="truncate">Official/firewalled</span>
                </span>
                <Switch
                  checked={sourceOfficialFirewall}
                  onCheckedChange={setSourceOfficialFirewall}
                  aria-label="Official/firewalled source"
                />
              </div>
              <Button className="w-full" onClick={addSource} disabled={!canAddSource}>
                <Plus className="h-4 w-4" aria-hidden />
                Add source
              </Button>

              <div className="space-y-2 rounded-md border bg-surface-1 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    <UploadCloud className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="truncate">Import bundle</span>
                  </span>
                  <Select
                    value={bundleFormat}
                    onValueChange={(value) => setBundleFormat(value as NotebookImportFormat)}
                  >
                    <SelectTrigger className="h-8 w-28" aria-label="Notebook import format">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {importFormatOptions.map((format) => (
                        <SelectItem key={format.value} value={format.value}>
                          {format.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  type="file"
                  accept=".json,.md,.markdown,.html,.htm,application/json,text/markdown,text/html"
                  onChange={(event) => setBundleFile(event.target.files?.[0] ?? null)}
                  aria-label="Import notebook bundle file"
                />
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {bundleFile ? bundleFile.name : "No file selected"}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                    Firewall
                  </span>
                  <Switch
                    checked={bundleOfficialFirewall}
                    onCheckedChange={setBundleOfficialFirewall}
                    aria-label="Import bundle as official/firewalled"
                  />
                </div>
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={importBundle}
                  disabled={!bundleFile}
                >
                  <UploadCloud className="h-4 w-4" aria-hidden />
                  Import bundle
                </Button>
              </div>

              <div className="space-y-2">
                {sources.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    onClick={() =>
                      source.artifact_id &&
                      selectArtifact(
                        `artifact:${source.artifact_id}`,
                        source.title,
                        source.official_firewall,
                      )
                    }
                    className="w-full rounded-md border bg-surface-1 p-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 truncate text-sm font-medium">{source.title}</p>
                      <SourceStatusPill status={source.status} official={source.official_firewall} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {humanize(source.source_type)} · {source.provider}
                    </p>
                  </button>
                ))}
                {!sources.length && (
                  <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    No sources yet.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </aside>

        <main className="min-w-0 space-y-4">
          <Card>
            <CardContent className="space-y-4 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <ContextToggle
                  value={contextMode}
                  onChange={setContextMode}
                  modes={contextModeOptions}
                />
                <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
                  {activeCitation && (
                    <CitationChip
                      target={activeCitation.target}
                      label={activeCitation.label}
                      official={activeCitation.official_firewall}
                    />
                  )}
                  <Select value={template} onValueChange={setTemplate}>
                    <SelectTrigger className="w-full sm:w-56" aria-label="Transformation template">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {transformTemplateOptions.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Tabs defaultValue="notes">
                <TabsList className="flex-wrap">
                  <TabsTrigger value="notes">Notes</TabsTrigger>
                  <TabsTrigger value="chat">Tutor Chat</TabsTrigger>
                  <TabsTrigger value="search">Search</TabsTrigger>
                </TabsList>

                <TabsContent value="notes" className="space-y-4">
                  <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_260px]">
                    <div className="space-y-3">
                      <Input
                        value={noteTitle}
                        onChange={(event) => setNoteTitle(event.target.value)}
                        placeholder="Note title"
                        aria-label="Note title"
                      />
                      <Textarea
                        value={noteContent}
                        onChange={(event) => setNoteContent(event.target.value)}
                        className="min-h-56"
                        placeholder="Write rationale, rule, passage map, or study synthesis"
                        aria-label="Note content"
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Select value={noteType} onValueChange={setNoteType}>
                          <SelectTrigger className="w-48" aria-label="Note type">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {noteTypeOptions.map((type) => (
                              <SelectItem key={type.value} value={type.value}>
                                {type.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="flex items-center gap-2">
                          {editingNoteId && (
                            <Button variant="outline" onClick={resetNoteEditor}>
                              New note
                            </Button>
                          )}
                          <Button onClick={addNote} disabled={!noteTitle.trim()}>
                            <FileText className="h-4 w-4" aria-hidden />
                            {editingNoteId ? "Update note" : "Save note"}
                          </Button>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      {notes.slice(0, 8).map((note) => (
                        <button
                          key={note.id}
                          type="button"
                          onClick={() => editNote(note)}
                          className="w-full rounded-md border bg-surface-1 p-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="min-w-0 truncate text-sm font-medium">{note.title}</p>
                            <Badge variant="outline" className="rounded-md">
                              {humanize(note.note_type)}
                            </Badge>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {note.content || "Empty note"}
                          </p>
                        </button>
                      ))}
                      {!notes.length && (
                        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                          No notes yet.
                        </p>
                      )}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="chat" className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Icon as={BrainCircuit} size="sm" />
                      <span>{sessions.length} scoped chats</span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        const session = await api.createNotebookChatSession({
                          title: "Notebook tutor",
                          mode: contextMode,
                          model: "local",
                          context: { refs: activeRefs },
                        });
                        setActiveSessionId(session.id);
                        await refreshWorkbench();
                      }}
                    >
                      <MessageSquareText className="h-4 w-4" aria-hidden />
                      New chat
                    </Button>
                  </div>

                  <div className="min-h-72 space-y-3 rounded-md border bg-surface-1 p-3">
                    {messages.map((message) => (
                      <div
                        key={message.id}
                        className={message.role === "assistant" ? "pr-8" : "pl-8"}
                      >
                        <div className="rounded-md border bg-background p-3">
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <Badge variant="outline" className="rounded-md">
                              {message.role}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {new Date(message.created_at).toLocaleTimeString()}
                            </span>
                          </div>
                          <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>
                          {message.citations.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {message.citations.map((raw, index) => {
                                const citation = citationFromRaw(raw);
                                return (
                                  <button
                                    key={`${message.id}-${citation.target}-${index}`}
                                    type="button"
                                    onClick={() => setActiveCitation(citation)}
                                    className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  >
                                    <CitationChip
                                      target={citation.target}
                                      label={citation.label}
                                      official={citation.official_firewall}
                                    />
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          {message.role === "assistant" && (
                            <div className="mt-3 flex justify-end">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => saveMessageAsNote(message)}
                              >
                                <FileText className="h-4 w-4" aria-hidden />
                                Save as note
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {!messages.length && (
                      <p className="text-sm text-muted-foreground">
                        Start a local scoped tutor thread.
                      </p>
                    )}
                  </div>

                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <Textarea
                      value={chatInput}
                      onChange={(event) => setChatInput(event.target.value)}
                      placeholder="Ask from the current notebook scope"
                      aria-label="Notebook tutor message"
                      className="min-h-20"
                    />
                    <Button className="sm:self-end" onClick={sendMessage} disabled={!chatInput.trim()}>
                      Send
                    </Button>
                  </div>
                </TabsContent>

                <TabsContent value="search" className="space-y-4">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className="pl-9"
                      placeholder="Search artifacts, notes, and sources"
                      aria-label="Search Notebook OS"
                    />
                  </div>
                  <div className="grid gap-3 lg:grid-cols-3">
                    {(search?.artifacts ?? []).map((artifact) => (
                      <button
                        key={`artifact-${artifact.id}`}
                        type="button"
                        onClick={() =>
                          selectArtifact(
                            `artifact:${artifact.id}`,
                            artifact.title,
                            artifact.official_firewall,
                          )
                        }
                        className="rounded-md border bg-surface-1 p-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Badge variant="outline" className="mb-2 rounded-md">
                          {artifact.kind}
                        </Badge>
                        <p className="truncate text-sm font-medium">{artifact.title}</p>
                        <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                          {artifact.summary || artifact.body}
                        </p>
                      </button>
                    ))}
                    {(search?.notes ?? []).map((note) => (
                      <button
                        key={`note-${note.id}`}
                        type="button"
                        onClick={() => editNote(note)}
                        className="rounded-md border bg-surface-1 p-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Badge variant="outline" className="mb-2 rounded-md">
                          note
                        </Badge>
                        <p className="truncate text-sm font-medium">{note.title}</p>
                        <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                          {note.content || "Empty note"}
                        </p>
                      </button>
                    ))}
                    {(search?.sources ?? []).map((source) => (
                      <button
                        key={`source-${source.id}`}
                        type="button"
                        onClick={() =>
                          source.artifact_id &&
                          selectArtifact(
                            `artifact:${source.artifact_id}`,
                            source.title,
                            source.official_firewall,
                          )
                        }
                        className="rounded-md border bg-surface-1 p-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Badge variant="outline" className="mb-2 rounded-md">
                          source
                        </Badge>
                        <p className="truncate text-sm font-medium">{source.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {humanize(source.source_type)} · {source.provider}
                        </p>
                      </button>
                    ))}
                  </div>
                  {query.trim().length > 1 &&
                    !search?.artifacts.length &&
                    !search?.notes.length &&
                    !search?.sources.length && (
                    <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                      No notebook evidence matched.
                    </p>
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          <div className="grid gap-4 2xl:grid-cols-3">
            <PageSection title="Transformations" eyebrow="Jobs">
              <div className="space-y-2">
                {transforms.slice(0, 4).map((run) => (
                  <div key={run.id} className="rounded-md border bg-surface-1 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">
                        {humanize(run.template_key)}
                      </p>
                      <Badge variant="outline" className="rounded-md">{run.status}</Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        {run.provider} · {run.input_refs.length} refs ·{" "}
                        {Number(run.metrics.evidence_count ?? 0)} evidence
                      </p>
                      {run.output_artifact_id && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            selectArtifact(
                              `artifact:${run.output_artifact_id}`,
                              humanize(run.template_key),
                              Boolean(run.firewall_decision?.official_firewall),
                            )
                          }
                        >
                          Open
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </PageSection>

            <PageSection title="Podcasts" eyebrow="Briefings">
              <div className="space-y-2">
                {podcasts.slice(0, 4).map((episode) => (
                  <div key={episode.id} className="rounded-md border bg-surface-1 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{episode.title}</p>
                      <Badge variant="outline" className="rounded-md">{episode.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {humanize(episode.episode_type)} · {episode.duration_sec ?? 0}s
                    </p>
                    <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">
                      {episode.transcript}
                    </p>
                    {episode.audio_path ? (
                      <audio
                        controls
                        preload="none"
                        src={api.podcastAudioUrl(episode.id)}
                        className="mt-3 h-9 w-full"
                      >
                        <track kind="captions" />
                      </audio>
                    ) : null}
                    <div className="mt-2 flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => savePodcastAsNote(episode)}
                      >
                        <FileText className="h-4 w-4" aria-hidden />
                        Save note
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </PageSection>

            <PageSection title="Wiki Pages" eyebrow="Legacy">
              <div className="space-y-2">
                {pages.slice(0, 4).map((page) => (
                  <div key={page.id} className="rounded-md border bg-surface-1 p-3">
                    <p className="truncate text-sm font-medium">{page.title}</p>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {page.summary || page.body}
                    </p>
                  </div>
                ))}
              </div>
            </PageSection>
          </div>
        </main>

        <aside className="space-y-4">
          <EvidencePanel
            citations={activeCitation ? [activeCitation] : []}
            inbox={inbox}
            backlinks={backlinks}
            versions={versions}
            artifact={activeArtifact}
            onSelectTarget={(target, label) => selectArtifact(target, label)}
            onUpdateInboxItem={updateInboxItem}
          />
          <ActivityCenter events={activity} />
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Context Presets</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {presets.map((preset) => (
                <Badge key={preset.id} variant="outline" className="rounded-md">
                  {preset.name}
                </Badge>
              ))}
            </CardContent>
          </Card>
        </aside>
      </div>
    </PageLayout>
  );
}
