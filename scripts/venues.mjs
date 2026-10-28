import {readFileSync} from 'node:fs';
export const venues = JSON.parse(readFileSync(new URL('../data/venues.json', import.meta.url)));
export function mapsURL(venue) {
  const entry = venues[venue];
  if (!entry?.query || !entry.source?.startsWith('https://')) throw Error(`Sede pendiente de verificar: ${venue}`);
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(entry.query);
}
// Una sede sin verificar no retrasa un partido: se publica con el nombre oficial de la sede, sin enlace de Maps,
// hasta que alguien compruebe la dirección y la añada a data/venues.json.
export function verifiedMapsURL(venue) {
  const entry = venues[venue];
  return entry?.query && entry.source?.startsWith('https://') ? mapsURL(venue) : null;
}
