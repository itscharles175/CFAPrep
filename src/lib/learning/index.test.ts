import { describe, expect, it } from 'vitest';
import {
  exportVaultData as directExportVaultData,
  getReviewInbox as directGetReviewInbox,
  recordQuizAttempt as directRecordQuizAttempt,
  repairVaultData as directRepairVaultData,
  saveResultArtifact as directSaveResultArtifact,
  VAULT_SCHEMA_VERSION as directSchemaVersion,
} from '../progressStore';
import {
  exportVaultData,
  getReviewInbox,
  recordQuizAttempt,
  repairVaultData,
  saveResultArtifact,
  VAULT_SCHEMA_VERSION,
} from '.';

describe('learning module facade', () => {
  it('keeps stable focused entry points over the local vault store', () => {
    expect(VAULT_SCHEMA_VERSION).toBe(directSchemaVersion);
    expect(recordQuizAttempt).toBe(directRecordQuizAttempt);
    expect(getReviewInbox).toBe(directGetReviewInbox);
    expect(exportVaultData).toBe(directExportVaultData);
    expect(repairVaultData).toBe(directRepairVaultData);
    expect(saveResultArtifact).toBe(directSaveResultArtifact);
  });
});

