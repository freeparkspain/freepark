export interface SearchResult {
  key: string;
  displayName: string;
  latitude: number;
  longitude: number;
}

/** Owns cancellation and monotonic IDs for latest-request-wins searches. */
export class LatestSearchRequest {
  private sequence = 0;
  private controller: AbortController | null = null;

  start(): { requestId: number; controller: AbortController } {
    this.controller?.abort();
    this.controller = new AbortController();
    this.sequence += 1;
    return { requestId: this.sequence, controller: this.controller };
  }

  invalidate(): void {
    this.sequence += 1;
    this.controller?.abort();
    this.controller = null;
  }

  isCurrent(requestId: number): boolean {
    return requestId === this.sequence && this.controller?.signal.aborted === false;
  }

  finish(requestId: number): void {
    if (requestId === this.sequence) this.controller = null;
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildDisplayName(properties: JsonRecord): string {
  const name = optionalString(properties, 'name');
  const street = optionalString(properties, 'street');
  const houseNumber = optionalString(properties, 'housenumber');
  const streetAndNumber = houseNumber
    ? `${street ?? ''} ${houseNumber}`.trim()
    : street;

  return [
    name !== street ? name : undefined,
    streetAndNumber,
    optionalString(properties, 'district'),
    optionalString(properties, 'city'),
    optionalString(properties, 'state'),
    optionalString(properties, 'country'),
  ].filter((part): part is string => Boolean(part)).join(', ');
}

function parseFeature(value: unknown): SearchResult | null {
  if (!isRecord(value) || !isRecord(value.geometry) || !isRecord(value.properties)) {
    return null;
  }

  const coordinates = value.geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [longitude, latitude] = coordinates;
  if (
    typeof latitude !== 'number'
    || typeof longitude !== 'number'
    || !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90
    || Math.abs(longitude) > 180
  ) {
    return null;
  }

  const osmId = value.properties.osm_id;
  if ((typeof osmId !== 'number' && typeof osmId !== 'string') || String(osmId).trim() === '') {
    return null;
  }

  const displayName = buildDisplayName(value.properties);
  if (!displayName) return null;
  const osmType = optionalString(value.properties, 'osm_type') ?? 'osm';

  return {
    key: `${osmType}:${String(osmId)}:${longitude}:${latitude}`,
    displayName,
    latitude,
    longitude,
  };
}

/** Runtime boundary for the untrusted Photon response. Malformed items are skipped. */
export function parsePhotonResponse(value: unknown): SearchResult[] {
  if (!isRecord(value) || !Array.isArray(value.features)) return [];
  return value.features
    .map(parseFeature)
    .filter((result): result is SearchResult => result !== null);
}
