import { Check, Clock3, History, Inbox, Link2, Network } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Badge } from "@lsat/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { Icon } from "@lsat/components/ui/icon";
import type {
  ArtifactVersion,
  BacklinkRecord,
  CitationTarget,
  KnowledgeInboxItem,
  StudyArtifact,
} from "@lsat/lib/types";
import { CitationChip } from "./citation-chip";

function humanize(value: string) {
  return value.split("_").join(" ");
}

export function EvidencePanel({
  citations,
  inbox,
  backlinks = [],
  versions = [],
  artifact = null,
  onSelectTarget,
  onUpdateInboxItem,
}: {
  citations: CitationTarget[];
  inbox: KnowledgeInboxItem[];
  backlinks?: BacklinkRecord[];
  versions?: ArtifactVersion[];
  artifact?: StudyArtifact | null;
  onSelectTarget?: (target: string, label: string) => void;
  onUpdateInboxItem?: (id: number, patch: { status?: string; priority?: number }) => void;
}) {
  return (
    <div className="space-y-3">
      {artifact && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Icon as={Link2} size="sm" />
              Selected Artifact
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-medium">{artifact.title}</p>
              <Badge variant="outline" className="shrink-0 rounded-md">
                {humanize(artifact.kind)}
              </Badge>
            </div>
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border bg-surface-1 p-3 text-xs leading-5 text-muted-foreground">
              {artifact.official_firewall
                ? artifact.summary || "Official local-only artifact. Open it inside the original study surface."
                : artifact.body || artifact.summary || "Empty artifact"}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Icon as={Link2} size="sm" />
            Evidence
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {citations.length ? (
            citations.map((citation) => (
              <CitationChip
                key={citation.target}
                target={citation.target}
                label={citation.label}
                official={citation.official_firewall}
              />
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No active citation scope.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Icon as={Network} size="sm" />
            Backlinks
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {backlinks.slice(0, 6).map((link) => (
            <div key={link.id} className="rounded-md border bg-surface-1 p-2">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 truncate text-sm font-medium">
                  {link.source_title || `Artifact ${link.source_artifact_id}`}
                </p>
                <Badge variant="outline" className="shrink-0 rounded-md">
                  {humanize(link.source_kind || link.relation)}
                </Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {link.source_official_firewall
                  ? "Official content remains local-only."
                  : link.source_summary || link.target_ref}
              </p>
            </div>
          ))}
          {!backlinks.length && (
            <p className="text-sm text-muted-foreground">No linked artifacts yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Icon as={History} size="sm" />
            Version History
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {versions.slice(0, 5).map((version) => (
            <div key={version.id} className="rounded-md border bg-surface-1 p-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">v{version.version}</p>
                <Badge variant="outline" className="rounded-md">
                  {humanize(version.reason || "snapshot")}
                </Badge>
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {version.snapshot.title || `Artifact ${version.artifact_id}`}
              </p>
            </div>
          ))}
          {!versions.length && (
            <p className="text-sm text-muted-foreground">Select an artifact to inspect revisions.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Icon as={Inbox} size="sm" />
            Knowledge Inbox
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {inbox.slice(0, 5).map((item) => (
            <div key={item.id} className="rounded-md border bg-surface-1 p-2">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 truncate text-sm font-medium">
                  {item.artifact_title || item.origin}
                </p>
                <Badge variant="outline" className="shrink-0 rounded-md">
                  {item.status}
                </Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {item.reason}
              </p>
              {(item.artifact_id || onUpdateInboxItem) && (
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  {item.artifact_id && onSelectTarget && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        onSelectTarget(
                          `artifact:${item.artifact_id}`,
                          item.artifact_title || item.origin,
                        )
                      }
                    >
                      <Link2 className="h-3.5 w-3.5" aria-hidden />
                      Open
                    </Button>
                  )}
                  {onUpdateInboxItem && item.status !== "snoozed" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onUpdateInboxItem(item.id, { status: "snoozed" })}
                    >
                      <Clock3 className="h-3.5 w-3.5" aria-hidden />
                      Later
                    </Button>
                  )}
                  {onUpdateInboxItem && item.status !== "resolved" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onUpdateInboxItem(item.id, { status: "resolved" })}
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden />
                      Done
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
          {!inbox.length && (
            <p className="text-sm text-muted-foreground">Captured evidence will queue here.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
