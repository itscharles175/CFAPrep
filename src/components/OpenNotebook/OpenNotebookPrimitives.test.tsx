import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CitationChip, InsightCard, SourceLegend } from './OpenNotebookPrimitives';

describe('CitationChip', () => {
  it('renders the number with the qv-chip class', () => {
    render(<CitationChip number={3} title="Test source" />);
    const chip = screen.getByText('3');
    expect(chip.className).toContain('qv-chip');
    expect(chip.getAttribute('data-citation')).toBe('3');
    expect(chip.getAttribute('title')).toBe('Test source');
    expect(chip.getAttribute('aria-label')).toContain('Test source');
  });

  it('falls back to "Citation <n>" when no title given', () => {
    render(<CitationChip number={1} />);
    const chip = screen.getByText('1');
    expect(chip.getAttribute('aria-label')).toBe('Citation 1');
  });

  it('adds a margin-left when spaced=true', () => {
    render(<CitationChip number={2} spaced />);
    const chip = screen.getByText('2');
    expect(chip.className).toContain('qv-ml-1');
  });
});

describe('SourceLegend', () => {
  it('renders nothing when entries is empty', () => {
    const { container } = render(<SourceLegend entries={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one row per entry with title + monospace id', () => {
    render(
      <SourceLegend entries={[
        { id: 'abc-123', title: 'Quant Volume I' },
        { id: 'def-456' },  // no title — fallback
      ]} />,
    );
    expect(screen.getByText('Quant Volume I')).toBeInTheDocument();
    expect(screen.getByText('abc-123').className).toContain('qv-mono');
    expect(screen.getByText('Curriculum source')).toBeInTheDocument();
  });

  it('renders a CitationChip per entry numbered 1..N', () => {
    render(
      <SourceLegend entries={[
        { id: 'a' },
        { id: 'b' },
        { id: 'c' },
      ]} />,
    );
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});

describe('InsightCard', () => {
  it('renders body content under a qv-callout container', () => {
    const { container } = render(
      <InsightCard title="Time value of money">
        A dollar today is worth more than a dollar tomorrow.
      </InsightCard>,
    );
    expect(container.querySelector('.qv-callout')).not.toBeNull();
    expect(screen.getByText(/Time value of money/i)).toBeInTheDocument();
    expect(screen.getByText(/A dollar today/i)).toBeInTheDocument();
  });

  it('renders a locator chip when provided', () => {
    render(
      <InsightCard title="Duration" locator="p.42">
        Bond price sensitivity.
      </InsightCard>,
    );
    const chip = screen.getByText('p.42');
    expect(chip.className).toContain('qv-chip');
    expect(chip.className).toContain('qv-mono');
  });

  it('applies tone styling on the title', () => {
    render(
      <InsightCard title="Caution" tone="warning">
        Watch for time-pressure errors.
      </InsightCard>,
    );
    const titleEl = screen.getByText('Caution');
    expect(titleEl.className).toContain('qv-text-warning');
  });

  it('renders without title or locator', () => {
    render(<InsightCard>Plain body only.</InsightCard>);
    expect(screen.getByText('Plain body only.')).toBeInTheDocument();
  });
});
