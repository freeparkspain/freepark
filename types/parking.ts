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
