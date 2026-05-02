export type ParkingType = 'free' | 'paid' | 'unknown';

export interface ParkingSpot {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  type: ParkingType;
  description: string;
  address?: string;
  maxHours?: number | null;
  notes?: string;
}

export type RootStackParamList = {
  Map: undefined;
  ParkingDetails: { spotId: string };
};

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface BBox {
  south: number;
  west:  number;
  north: number;
  east:  number;
}

export interface OsmParking {
  id:       string;
  position: LatLng;
  polygon:  LatLng[] | null;
  polyline: LatLng[] | null;
  tags:     Record<string, string>;
}

export interface RouteInfo {
  distance: number;
  duration: number;
}
