import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionTabs, sessionPanelId, sessionTabId, type SessionTab } from './SessionTabs';

const TABS: SessionTab[] = [
  { id: 'timer', label: 'Timer' },
  { id: 'plan', label: 'Plan' },
  { id: 'journal', label: 'Journal' },
];

function setup(active = 'timer') {
  const onChange = vi.fn();
  render(
    <SessionTabs tabs={TABS} activeId={active} onChange={onChange} label="Study session" idBase="t" />,
  );
  return { onChange };
}

describe('SessionTabs', () => {
  it('renders an accessible tablist with one selected tab', () => {
    setup('plan');
    expect(screen.getByRole('tablist', { name: 'Study session' })).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    const selected = screen.getByRole('tab', { selected: true });
    expect(selected).toHaveTextContent('Plan');
  });

  it('wires aria-controls / ids deterministically', () => {
    setup('timer');
    const tab = screen.getByRole('tab', { name: 'Timer' });
    expect(tab).toHaveAttribute('id', sessionTabId('t', 'timer'));
    expect(tab).toHaveAttribute('aria-controls', sessionPanelId('t', 'timer'));
  });

  it('uses roving tabindex — only the active tab is in the tab order', () => {
    setup('plan');
    expect(screen.getByRole('tab', { name: 'Plan' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Timer' })).toHaveAttribute('tabindex', '-1');
  });

  it('ArrowRight moves to the next tab and wraps at the end', async () => {
    const user = userEvent.setup();
    const { onChange } = setup('timer');
    screen.getByRole('tab', { name: 'Timer' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('plan');
  });

  it('ArrowLeft from the first tab wraps to the last', async () => {
    const user = userEvent.setup();
    const { onChange } = setup('timer');
    screen.getByRole('tab', { name: 'Timer' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('journal');
  });

  it('Home and End jump to the first / last tab', async () => {
    const user = userEvent.setup();
    const { onChange } = setup('plan');
    screen.getByRole('tab', { name: 'Plan' }).focus();
    await user.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('journal');
    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('timer');
  });

  it('clicking a tab calls onChange with its id', async () => {
    const user = userEvent.setup();
    const { onChange } = setup('timer');
    await user.click(screen.getByRole('tab', { name: 'Journal' }));
    expect(onChange).toHaveBeenCalledWith('journal');
  });
});
