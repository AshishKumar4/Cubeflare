export const MINECRAFT_LOCATION_OPTIONS = [
  { value: 'auto', label: 'Automatic' },
  { value: 'wnam', label: 'Western North America' },
  { value: 'enam', label: 'Eastern North America' },
  { value: 'sam', label: 'South America' },
  { value: 'weur', label: 'Western Europe' },
  { value: 'eeur', label: 'Eastern Europe' },
  { value: 'apac', label: 'Asia Pacific' },
  { value: 'oc', label: 'Oceania' },
  { value: 'afr', label: 'Africa' },
  { value: 'me', label: 'Middle East' }
] as const;

export type MinecraftLocationPreference = (typeof MINECRAFT_LOCATION_OPTIONS)[number]['value'];

const LOCATION_VALUES = new Set(MINECRAFT_LOCATION_OPTIONS.map((option) => option.value));

export function cleanMinecraftLocationPreference(value: unknown): MinecraftLocationPreference {
  return typeof value === 'string' && LOCATION_VALUES.has(value as MinecraftLocationPreference)
    ? (value as MinecraftLocationPreference)
    : 'auto';
}

export function minecraftLocationLabel(value: unknown): string {
  const preference = cleanMinecraftLocationPreference(value);
  return MINECRAFT_LOCATION_OPTIONS.find((option) => option.value === preference)?.label ?? 'Automatic';
}

export function durableObjectLocationHint(
  value: MinecraftLocationPreference
): DurableObjectLocationHint | undefined {
  return value === 'auto' ? undefined : value;
}
