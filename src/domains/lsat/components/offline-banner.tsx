import { useState } from "react";
import { useSyncExternalStore } from "react";
import { RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";
import { SystemNotice } from "@lsat/components/system-notice";
import { getOfflineStatus, subscribeOfflineStatus } from "@lsat/lib/offline";
import { flushQueue } from "@lsat/lib/offlineQueue";
import { toast } from "@lsat/lib/toast";

function getStatusSnapshot() {
  return getOfflineStatus();
}

/**
 * Global banner when API is unreachable or writes are queued.
 *
 * R9 (docs/19 F4) — now speaks the unified {@link SystemNotice} status language
 * so the offline advisory matches the AI-prereq and error-pattern notices
 * (dropping the bespoke full-bleed strip + `border-warning/30` idiom).
 */
export function OfflineBanner() {
  const { offline, queueDepth } = useSyncExternalStore(
    subscribeOfflineStatus,
    getStatusSnapshot,
    () => ({ offline: false, queueDepth: 0 }),
  );
  const [syncing, setSyncing] = useState(false);

  if (!offline && queueDepth === 0) return null;

  async function syncNow() {
    setSyncing(true);
    try {
      const { flushed, failed } = await flushQueue();
      if (flushed > 0 && failed === 0) {
        toast.success(`Synced ${flushed} pending write${flushed === 1 ? "" : "s"}`);
      } else if (flushed > 0) {
        toast.warning(
          `Synced ${flushed}; ${failed} still queued — is the API running?`,
        );
      } else if (failed > 0) {
        toast.error("Could not sync — backend still unreachable");
      } else {
        toast.info("Nothing to sync");
      }
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="px-4 pt-3 print:hidden">
      <SystemNotice
        tone="warning"
        icon={WifiOff}
        action={
          queueDepth > 0 ? (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={syncing}
              onClick={() => void syncNow()}
            >
              <Icon
                as={RefreshCw}
                size="xs"
                className={syncing ? "animate-spin motion-reduce:animate-none" : ""}
              />
              {syncing ? "Syncing…" : "Sync now"}
            </Button>
          ) : undefined
        }
      >
        {offline
          ? "Backend offline — showing sample data where needed."
          : "Pending writes queued locally."}
        {queueDepth > 0 && (
          <span className="ml-1 font-medium tabular-nums">
            {queueDepth} item{queueDepth === 1 ? "" : "s"} waiting to sync.
          </span>
        )}
      </SystemNotice>
    </div>
  );
}
