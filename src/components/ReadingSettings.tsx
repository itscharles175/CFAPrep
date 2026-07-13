/**
 * Wave 6 reading-craft settings panel (UI-2 density · UI-3 reading themes ·
 * A11Y-1 inclusive-reading engine). Host-styled (Primitives + index.css classes),
 * fully keyboard-accessible, and persists every choice through the dedicated
 * localStorage-backed stores (NOT the Dexie schema):
 *
 *   - base theme  → useTheme()  (src/context/ThemeContext — the existing switcher)
 *   - reading theme → readingTheme.ts  (data-reading-theme override axis)
 *   - density + reading prefs → useReadingPrefs()  (data-density + data-reading-*)
 *
 * The panel re-renders nothing in the page on change — the engine drives <html>
 * attributes/CSS variables and the page re-themes via the cascade.
 */

import { useEffect, useState } from 'react';
import {
  BookOpen,
  Contrast,
  Highlighter,
  Monitor,
  Moon,
  Ruler,
  ScanLine,
  Sun,
  Type,
} from 'lucide-react';
import { PageSection, Panel, SegmentedControl, StatusBadge } from './ui/Primitives';
import { useTheme } from '../context/ThemeContext';
import { useReadingPrefs } from '../lib/reading/useReadingPrefs';
import {
  getStoredReadingTheme,
  setReadingTheme,
  subscribeReadingTheme,
  type ReadingTheme,
} from '../lib/reading/readingTheme';
import type { ThemeName } from '../lib/theme';

const BASE_THEME_OPTIONS: { value: ThemeName; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

const READING_THEME_OPTIONS: { value: ReadingTheme; label: string; icon: typeof BookOpen }[] = [
  { value: 'default', label: 'Default', icon: BookOpen },
  { value: 'warm-paper', label: 'Warm paper', icon: Sun },
  { value: 'high-contrast', label: 'High contrast', icon: Contrast },
];

const DENSITY_OPTIONS = [
  { value: 'comfortable' as const, label: 'Comfortable' },
  { value: 'compact' as const, label: 'Compact' },
];

interface ReadingToggle {
  key: 'dyslexiaFont' | 'textSpacing' | 'bionicReading' | 'lineFocus';
  label: string;
  description: string;
  icon: typeof Type;
}

const READING_TOGGLES: ReadingToggle[] = [
  {
    key: 'dyslexiaFont',
    label: 'Dyslexia-friendly font',
    description: 'Switch body text to a weighted, high-legibility typeface.',
    icon: Type,
  },
  {
    key: 'textSpacing',
    label: 'Increased text spacing',
    description: 'WCAG 1.4.12 line, letter, word, and paragraph spacing.',
    icon: ScanLine,
  },
  {
    key: 'bionicReading',
    label: 'Bionic reading',
    description: 'Emphasise the leading part of each word to guide the eye.',
    icon: Highlighter,
  },
  {
    key: 'lineFocus',
    label: 'Line-focus ruler',
    description: 'A reading band that follows the pointer to anchor your line.',
    icon: Ruler,
  },
];

export default function ReadingSettings({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const prefs = useReadingPrefs();

  // Reading theme has its own store (not in ThemeContext, to avoid touching the
  // shared base-theme axis); mirror it into local state + subscribe so the panel
  // stays in sync with cross-tab / palette changes.
  const [readingTheme, setReadingThemeState] = useState<ReadingTheme>(() => getStoredReadingTheme());
  useEffect(() => subscribeReadingTheme(setReadingThemeState), []);

  return (
    <div className={className}>
      {/* UI-3 base theme — reuses the existing switcher's setTheme */}
      <PageSection
        title="Appearance"
        subtitle="Base palette plus an optional reading overlay tuned for long sessions."
      >
        <Panel
          tone="default"
          title="Theme"
          subtitle="Choose the base light or dark palette, or follow your system."
        >
          <SegmentedControl
            label="Base theme"
            value={theme}
            onChange={(value) => setTheme(value as ThemeName)}
            options={BASE_THEME_OPTIONS}
          />
        </Panel>

        <Panel
          tone="study"
          title="Reading theme"
          subtitle="Layered on top of the base palette for comfortable long-form reading."
        >
          <SegmentedControl
            label="Reading theme"
            value={readingTheme}
            onChange={(value) => setReadingTheme(value as ReadingTheme)}
            options={READING_THEME_OPTIONS}
          />
        </Panel>
      </PageSection>

      {/* UI-2 density */}
      <PageSection
        title="Density"
        subtitle="Tighten spacing and row heights on data-dense screens."
      >
        <Panel tone="default" title="Layout density" subtitle="Applies app-wide.">
          <SegmentedControl
            label="Density"
            value={prefs.density}
            onChange={(value) => prefs.setDensity(value as 'comfortable' | 'compact')}
            options={DENSITY_OPTIONS}
          />
        </Panel>
      </PageSection>

      {/* A11Y-1 inclusive-reading engine */}
      <PageSection
        title="Inclusive reading"
        subtitle="Reading aids you can combine. Each persists locally and applies instantly."
      >
        <Panel tone="default" title="Reading aids">
          <div className="reading-toggle-list" role="group" aria-label="Reading aids">
            {READING_TOGGLES.map(({ key, label, description, icon: Icon }) => {
              const on = prefs[key];
              return (
                <div key={key} className="reading-toggle-row">
                  <div className="reading-toggle-copy">
                    <span className="reading-toggle-label">
                      <Icon size={16} aria-hidden="true" />
                      {label}
                    </span>
                    <small>{description}</small>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={`${label}: ${on ? 'on' : 'off'}`}
                    className={`reading-switch ${on ? 'active' : ''}`}
                    onClick={() => prefs.toggle(key)}
                  >
                    <span className="reading-switch-thumb" aria-hidden="true" />
                    <span className="reading-switch-state">{on ? 'On' : 'Off'}</span>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="reading-toggle-foot">
            <StatusBadge tone="accent">Local-only</StatusBadge>
            <button type="button" className="btn btn-ghost btn-sm" onClick={prefs.reset}>
              Reset reading aids
            </button>
          </div>
        </Panel>
      </PageSection>
    </div>
  );
}
