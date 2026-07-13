import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AccessibleChoiceGroup from './AccessibleChoiceGroup';

const OPTIONS = [
  { id: 'a', value: 'A', shortcut: 'A' },
  { id: 'b', value: 'B', shortcut: 'B' },
  { id: 'c', value: 'C', shortcut: 'C' },
];

function Harness({ readOnly = false, onSelect }: { readOnly?: boolean; onSelect?: (value: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <AccessibleChoiceGroup
      options={OPTIONS}
      selectedValue={selected}
      onSelect={(value) => {
        setSelected(String(value));
        onSelect?.(String(value));
      }}
      groupLabel="Shared answers"
      readOnly={readOnly}
    >
      {({ option, radioProps }) => (
        <button key={option.id} {...radioProps} aria-label={`Choice ${option.value}`}>
          {option.value}
        </button>
      )}
    </AccessibleChoiceGroup>
  );
}

describe('AccessibleChoiceGroup', () => {
  it('renders a named radiogroup with one tabbable radio', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Shared answers' })).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios.filter((radio) => radio.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(radios.filter((radio) => radio.getAttribute('tabindex') === '-1')).toHaveLength(2);
  });

  it('moves roving focus with arrows and wraps', () => {
    render(<Harness />);
    const radios = screen.getAllByRole('radio');
    radios[0].focus();

    fireEvent.keyDown(radios[0], { key: 'ArrowDown' });
    expect(radios[1]).toHaveFocus();

    fireEvent.keyDown(radios[1], { key: 'ArrowUp' });
    fireEvent.keyDown(radios[0], { key: 'ArrowUp' });
    expect(radios[2]).toHaveFocus();
  });

  it('selects the active option with Enter/Space and direct letter shortcuts', () => {
    render(<Harness />);
    const radios = screen.getAllByRole('radio');
    radios[0].focus();

    fireEvent.keyDown(radios[0], { key: 'End' });
    expect(radios[2]).toHaveFocus();
    fireEvent.keyDown(radios[2], { key: 'Enter' });
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(radios[2], { key: 'a' });
    expect(radios[0]).toHaveFocus();
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('does not swallow modified shortcuts needed by page-level commands', () => {
    const onSelect = vi.fn();
    const onWindowKeydown = vi.fn();
    window.addEventListener('keydown', onWindowKeydown);
    render(<Harness onSelect={onSelect} />);
    const first = screen.getAllByRole('radio')[0];

    fireEvent.keyDown(first, { key: 'Enter', ctrlKey: true });

    expect(onSelect).not.toHaveBeenCalled();
    expect(onWindowKeydown).toHaveBeenCalled();
    window.removeEventListener('keydown', onWindowKeydown);
  });

  it('keeps read-only groups navigable but non-committing', () => {
    const onSelect = vi.fn();
    render(<Harness readOnly onSelect={onSelect} />);
    const radios = screen.getAllByRole('radio');
    radios[0].focus();

    fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
    expect(radios[1]).toHaveFocus();
    fireEvent.keyDown(radios[1], { key: 'Enter' });
    fireEvent.click(radios[1]);

    expect(onSelect).not.toHaveBeenCalled();
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');
  });
});
