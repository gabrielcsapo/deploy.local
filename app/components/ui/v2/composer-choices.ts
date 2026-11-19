import type { ComputerModels, ModelChoice } from '../../../../shared/v2/contracts';

/** A chip names up to two choices, then counts them; with none it says what happens instead. */
export function chipLabel(names: string[], none: string, plural: string) {
  if (!names.length) return none;
  if (names.length <= 2) return names.join(', ');
  return `${names.length} ${plural}`;
}

/** "a", "a and b", "a, b and c". */
export function listNames(names: string[]) {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const efforts: Record<string, string> = {
  '': 'Default',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};
export function effortLabel(effort: string) {
  return efforts[effort] ?? effort[0]?.toUpperCase() + effort.slice(1);
}

/**
 * The model menu's two lists. The main list holds the models set as defaults in Computers ›
 * Models and this chat's pick; More models holds the rest, grouped by provider in their order.
 */
export function modelGroups(models: ComputerModels | null, override: string | null) {
  const choices = models?.choices ?? [];
  const pinned = new Set<string>(
    [...Object.values(models?.defaults ?? {}), override].filter(
      (value): value is string => typeof value === 'string' && Boolean(value),
    ),
  );
  const main = choices.filter((choice) => pinned.has(choice.id));
  const more: { provider: string; name: string; choices: ModelChoice[] }[] = [];
  for (const choice of choices) {
    if (pinned.has(choice.id)) continue;
    let group = more.find((item) => item.provider === choice.provider);
    if (!group) {
      group = {
        provider: choice.provider,
        name:
          models?.providers.find((provider) => provider.id === choice.provider)?.name ??
          choice.provider[0].toUpperCase() + choice.provider.slice(1),
        choices: [],
      };
      more.push(group);
    }
    group.choices.push(choice);
  }
  return { main, more };
}
