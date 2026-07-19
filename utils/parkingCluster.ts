import { OsmParking } from '../types/parking';

/** Identity of the IDs and positions represented by the spatial index. */
export function parkingClusterSignature(parkings: readonly OsmParking[]): string {
  return parkings
    .map(p => `${p.id.length}:${p.id}@${p.position.latitude},${p.position.longitude}`)
    .join('|');
}
