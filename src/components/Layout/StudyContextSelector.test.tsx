import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import StudyContextSelector from './StudyContextSelector';

describe('StudyContextSelector', () => {
  it('exposes a calm but explicit curriculum-change control', () => {
    render(
      <StudyContextSelector
        context={{ domain: 'cfa', cfaLevel: 'level3', goal: 'balanced' }}
        pathway="portfolio-management"
        onContextChange={vi.fn()}
        onPathwayChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Change')).toBeInTheDocument();
    expect(screen.getByLabelText('Change study context. Current: CFA, Level III, Balanced')).toHaveAttribute(
      'title',
      'Change curriculum, level, and study goal',
    );
  });

  it('delegates track and CFA-level changes to the atomic navigation handlers', async () => {
    const user = userEvent.setup();
    const onContextChange = vi.fn();
    const onDomainChange = vi.fn();
    const onLevelChange = vi.fn();

    render(
      <StudyContextSelector
        context={{ domain: 'cfa', cfaLevel: 'level1', goal: 'balanced' }}
        pathway="portfolio-management"
        onContextChange={onContextChange}
        onDomainChange={onDomainChange}
        onLevelChange={onLevelChange}
        onPathwayChange={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'Track' }), 'lsat');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Level' }), 'level2');

    expect(onDomainChange).toHaveBeenCalledWith('lsat');
    expect(onLevelChange).toHaveBeenCalledWith('level2');
    expect(onContextChange).not.toHaveBeenCalled();
  });
});
