import { LatLng } from '../../types/parking';

// ─── Polyline decoder (Google/OSRM encoded polyline algorithm) ────────────────
// OSRM is queried with `geometries=polyline6`, i.e. 6 decimals of precision, so
// the scaling factor is 1e6 (the classic Google format uses 1e5). Decodes to
// {latitude, longitude} in the order stored (lat, lon interleaved), NOT the
// lon,lat order OSRM uses for its *request* coordinates.
//
// Reference algorithm: https://developers.google.com/maps/documentation/utilities/polylinealgorithm

/**
 * Decode an encoded polyline string into coordinates.
 * @param encoded   the encoded geometry string
 * @param precision decimal precision (6 for polyline6, 5 for classic polyline)
 */
export function decodePolyline(encoded: string, precision = 6): LatLng[] {
  const factor = Math.pow(10, precision);
  const points: LatLng[] = [];

  let index = 0;
  let lat = 0;
  let lng = 0;
  const len = encoded.length;

  while (index < len) {
    lat += decodeSignedChunk();
    lng += decodeSignedChunk();
    points.push({ latitude: lat / factor, longitude: lng / factor });
  }

  return points;

  // Reads one varint-encoded, zig-zag signed delta starting at `index`.
  function decodeSignedChunk(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63; // undo the +63 offset
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20); // high bit set → more chunks follow
    // zig-zag decode: LSB is the sign bit
    return (result & 1) ? ~(result >> 1) : result >> 1;
  }
}

/** Convenience wrapper for OSRM's polyline6 geometry. */
export const decodePolyline6 = (encoded: string): LatLng[] => decodePolyline(encoded, 6);

/**
 * Encode coordinates back to a polyline string (used by tests to round-trip,
 * and handy for debugging). Mirrors `decodePolyline`.
 */
export function encodePolyline(points: LatLng[], precision = 6): string {
  const factor = Math.pow(10, precision);
  let output = '';
  let prevLat = 0;
  let prevLng = 0;

  for (const { latitude, longitude } of points) {
    const lat = Math.round(latitude * factor);
    const lng = Math.round(longitude * factor);
    output += encodeSignedChunk(lat - prevLat);
    output += encodeSignedChunk(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }

  return output;

  function encodeSignedChunk(value: number): string {
    let v = value < 0 ? ~(value << 1) : value << 1; // zig-zag
    let chunk = '';
    while (v >= 0x20) {
      chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    chunk += String.fromCharCode(v + 63);
    return chunk;
  }
}
