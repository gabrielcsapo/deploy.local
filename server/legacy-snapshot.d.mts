export interface LegacySnapshot {
  directory: string;
  archiveDigest: string;
  contentsDigest: string;
}
export function assertExistingLegacyData(directory: string): void;
export function snapshotStoppedLegacyData(
  volumeDirectory: string,
  recoveryRoot: string,
): LegacySnapshot;
export function verifyLegacySnapshot(snapshot: LegacySnapshot): void;
export function restoreStoppedLegacyData(volumeDirectory: string, snapshot: LegacySnapshot): void;

export function legacyHostIdentityDigest(directory: string): string;
