import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReadingSettings from './ReadingSettings';
import { ThemeProvider } from '../context/ThemeContext';

function renderPanel() {
  return render(
    <ThemeProvider>
      <ReadingSettings />
    </ThemeProvider>,
  );
}

const root = () => document.documentElement;

beforeEach(() => {
  window.localStorage.clear();
  root().removeAttribute('data-density');
  root().removeAttribute('data-reading-theme');
  root().removeAttribute('data-reading-font');
  root().removeAttribute('data-text-spacing');
  root().removeAttribute('data-bionic');
  root().removeAttribute('data-line-focus');
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('ReadingSettings — Wave 6 reading-craft panel', () => {
  it('renders the theme, reading-theme, density, and reading-aid controls', () => {
    renderPanel();
    expect(screen.getByRole('radiogroup', { name: 'Base theme' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Reading theme' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Reading aids' })).toBeInTheDocument();
  });

  it('switches density to compact, stamping data-density and persisting', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('radio', { name: 'Compact' }));
    expect(root().getAttribute('data-density')).toBe('compact');
    expect(JSON.parse(window.localStorage.getItem('qv-reading-prefs')!).density).toBe('compact');
  });

  it('applies a reading theme via the override axis', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('radio', { name: /Warm paper/ }));
    expect(root().getAttribute('data-reading-theme')).toBe('warm-paper');
    expect(window.localStorage.getItem('qv-reading-theme')).toBe('warm-paper');
  });

  it('toggles a reading aid (switch role) and reflects aria-checked', async () => {
    const user = userEvent.setup();
    renderPanel();
    const dyslexia = screen.getByRole('switch', { name: /Dyslexia-friendly font/ });
    expect(dyslexia).toHaveAttribute('aria-checked', 'false');
    await user.click(dyslexia);
    expect(dyslexia).toHaveAttribute('aria-checked', 'true');
    expect(root().getAttribute('data-reading-font')).toBe('dyslexic');
  });

  it('resets reading aids back to neutral', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('switch', { name: /Bionic reading/ }));
    expect(root().getAttribute('data-bionic')).toBe('on');
    await user.click(screen.getByRole('button', { name: 'Reset reading aids' }));
    expect(root().hasAttribute('data-bionic')).toBe(false);
  });
});
