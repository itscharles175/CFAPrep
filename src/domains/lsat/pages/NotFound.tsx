import { useNavigate } from "react-router-dom";
import { FileQuestion, Search } from "lucide-react";
import { PageLayout } from "@lsat/components/page-layout";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@lsat/components/states";
import { KEYBOARD_HELP_EVENT } from "@lsat/components/keyboard-help";

export default function NotFound() {
  const navigate = useNavigate();
  return (
    <PageLayout title="Page not found" width="md">
      <EmptyState
        icon={<FileQuestion className="h-6 w-6" />}
        title="This page doesn't exist"
        description="The link may be outdated or mistyped. Jump home, open the command palette, or go back."
        action={
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => navigate("/dashboard")}>Go to Dashboard</Button>
            <Button variant="outline" onClick={() => navigate(-1)}>
              Go back
            </Button>
            <Button
              variant="outline"
              onClick={() => window.dispatchEvent(new Event(KEYBOARD_HELP_EVENT))}
            >
              <Search className="h-4 w-4" />
              Shortcuts
            </Button>
          </div>
        }
      />
    </PageLayout>
  );
}
