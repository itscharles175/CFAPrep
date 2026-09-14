import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchSidecar, saveSettings } = vi.hoisted(() => ({
  fetchSidecar: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('./lsatSidecarClient', () => ({
  fetchLsatSidecarJson: fetchSidecar,
}));

vi.mock('./progressStore', () => ({
  getStudyPlanSettings: vi.fn(),
  saveStudyPlanSettings: saveSettings,
  studyPlanSettingsToProfile: vi.fn(() => ({
    hasPlan: false,
    targetScore: 165,
    examDate: null,
    dailyMinutes: 60,
    targetLevel: null,
    restDays: [],
    mockCadenceDays: null,
    topicWeights: {},
    domainGoals: {},
    timeAllocation: {},
    lastWriter: 'host',
    updatedAt: null,
  })),
  studyProfileToPlanSettingsPatch: vi.fn(() => ({})),
}));

import { saveStudyProfile } from './studyProfileBridge';

describe('studyProfileBridge adaptive profile fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveSettings.mockResolvedValue({});
  });

  it('round-trips domain goals and time allocation through the snake-case wire contract', async () => {
    fetchSidecar.mockResolvedValue({
      reachable: true,
      ok: true,
      status: 200,
      data: {
        domain_goals: {
          cfa: { enabled: true, goal: 'Pass Level II', target_date: '2027-05-01' },
        },
        time_allocation: { cfa: 75, lsat: 30 },
      },
    });

    const result = await saveStudyProfile({
      domainGoals: {
        cfa: { enabled: true, goal: 'Pass Level II', targetDate: '2027-05-01' },
      },
      timeAllocation: { cfa: 75, lsat: 30 },
    });

    const request = fetchSidecar.mock.calls[0][1];
    expect(JSON.parse(request.body)).toMatchObject({
      domain_goals: {
        cfa: { enabled: true, goal: 'Pass Level II', targetDate: '2027-05-01' },
      },
      time_allocation: { cfa: 75, lsat: 30 },
      last_writer: 'host',
    });
    expect(result.profile.domainGoals.cfa).toEqual({
      enabled: true,
      goal: 'Pass Level II',
      targetDate: '2027-05-01',
    });
    expect(result.profile.timeAllocation).toEqual({ cfa: 75, lsat: 30 });
  });
});
