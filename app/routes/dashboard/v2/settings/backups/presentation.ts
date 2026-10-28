import type { BackupsResponse } from '../../../../../../shared/v2/contracts.ts';

/** Only known local paths establish locality; remote/unknown destinations suppress the claim. */
export function allCopiesLocal(data: BackupsResponse) {
  const destinations = [
    ...data.backups.map((point) => point.destination),
    ...data.schedules.map((schedule) => schedule.destination),
  ];
  return (
    destinations.length > 0 &&
    destinations.every((destination) => /^\/(?!\/)|^[A-Za-z]:[\\/]/.test(destination))
  );
}
