// Capitalise each hyphen-separated word: "hydro-pump" -> "Hydro Pump"
export function formatName(slug: string): string {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Same as formatName, but special-cases the project's synthetic item ids:
// TM/HM ("tm-flamethrower" -> "TM: Flamethrower") and mints ("mint-bold" -> "Bold Mint").
export function formatItemName(slug: string): string {
  if (slug.startsWith('tm-')) {
    return `TM: ${formatItemName(slug.slice(3))}`;
  }
  if (slug.startsWith('mint-')) {
    const nature = slug.slice(5);
    return `${nature.charAt(0).toUpperCase() + nature.slice(1)} Mint`;
  }
  return formatName(slug);
}
