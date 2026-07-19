import { Linking } from 'react-native';
import { LatLng } from '../../types/parking';
import { isValidCoordinate } from '../../navigation/services/routeValidator';

const GOOGLE_MAPS_DIRECTIONS_URL = 'https://www.google.com/maps/dir/';

/**
 * A universal HTTPS URL works on both mobile platforms: Google Maps opens it
 * when installed and the browser remains a reliable fallback when it is not.
 */
export function buildExternalMapsUrl(destination: LatLng): string {
  if (!isValidCoordinate(destination)) {
    throw new Error('Invalid destination coordinates');
  }
  const query = new URLSearchParams({
    api: '1',
    destination: `${destination.latitude},${destination.longitude}`,
    travelmode: 'driving',
  });
  return `${GOOGLE_MAPS_DIRECTIONS_URL}?${query.toString()}`;
}

export async function openExternalMaps(destination: LatLng): Promise<void> {
  const url = buildExternalMapsUrl(destination);
  const supported = await Linking.canOpenURL(url);
  if (!supported) throw new Error('No application can open map directions');
  await Linking.openURL(url);
}
