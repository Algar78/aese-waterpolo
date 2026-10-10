import {readFileSync} from 'node:fs';
export const venues = JSON.parse(readFileSync(new URL('../data/venues.json', import.meta.url)));
export function mapsURL(venue) {
  const entry = venues[venue];
  if (!entry?.query || !entry.source?.startsWith('https://')) throw Error(`Sede pendiente de verificar: ${venue}`);
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(entry.query);
}
