import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StudySessionCard, type StudySessionPanel } from './StudySessionCard';

const PANELS: StudySessionPanel[] = [
  { id: 'timer', label: 'Timer', content: <p>timer body</p> },
  { id: 'plan', label: 'Plan', content: <p>plan body</p> },
  { id: 'journal', label: 'Journal', content: <p>journal body</p> },
];

describe('StudySessionCard', () => {
  it('renders the first panel by default with a labelled region', () => {
    render(<StudySessionCard panels={PANELS} idBase="s" />);
    expect(screen.getByRole('region', { name: 'Study session' })).toBeInTheDocument();
    expect(screen.getByText('timer body')).toBeInTheDocument();
    expect(screen.queryByText('plan body')).not.toBeInTheDocument();
  });

  it('honors defaultTabId', () => {
    render(<StudySessionCard panels={PANELS} defaultTabId="journal" idBase="s" />);
    expect(screen.getByText('journal body')).toBeInTheDocument();
  });

  it('switches the visible panel when a tab is clicked', async () => {
    render(<StudySessionCard panels={PANELS} idBase="s" />);
    await userEvent.click(screen.getByRole('tab', { name: 'Plan' }));
    expect(screen.getByText('plan body')).toBeInTheDocument();
    expect(screen.queryByText('timer body')).not.toBeInTheDocument();
    // tabpanel is labelled by the active tab
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby');
  });

  it('renders nothing for an empty panel set', () => {
    const { container } = render(<StudySessionCard panels={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
