import { create } from 'zustand';
import { ParkingSpot } from '../types/parking';
import spotsData from '../data/parkingSpots.json';

interface ParkingState {
  spots: ParkingSpot[];
  selectedSpot: ParkingSpot | null;
  filterOnlyFree: boolean;
  setSelectedSpot: (spot: ParkingSpot | null) => void;
  toggleFilterOnlyFree: () => void;
}

export const useParkingStore = create<ParkingState>((set) => ({
  spots: spotsData as ParkingSpot[],
  selectedSpot: null,
  filterOnlyFree: false,
  setSelectedSpot: (spot) => set({ selectedSpot: spot }),
  toggleFilterOnlyFree: () =>
    set((state) => ({ filterOnlyFree: !state.filterOnlyFree })),
}));

/** Derived selector — returns spots filtered by current toggle state. */
export const useFilteredSpots = (): ParkingSpot[] => {
  const { spots, filterOnlyFree } = useParkingStore();
  return filterOnlyFree ? spots.filter((s) => s.type === 'free') : spots;
};
