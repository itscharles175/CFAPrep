/**
 * Settings — host preferences surface (Wave 6 follow-up).
 *
 * A minimal, host-styled page whose only job today is to give the Wave 6
 * <ReadingSettings/> panel a reachable home: appearance (base + reading theme),
 * layout density, and the inclusive-reading aids all live there. Registered
 * additively in App.jsx (its own `/settings` route — same pattern as
 * `/leeches`), so it stays out of the typed routeManifest.
 *
 * Pure presentation: the panel persists every choice through its own
 * localStorage-backed reading engine; this page adds no state of its own.
 */
import { PageHeader } from '../components/ui/Primitives';
import ReadingSettings from '../components/ReadingSettings';

export default function Settings() {
  return (
    <div className="page-container">
      <PageHeader
        eyebrow="Local-only"
        title="Preferences"
        subtitle="Appearance, layout density, and reading aids. Every choice is stored on this device."
      />
      <ReadingSettings />
    </div>
  );
}
