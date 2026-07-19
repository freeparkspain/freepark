import React from 'react';
import { TouchableOpacity, Text, View, StyleSheet, Platform } from 'react-native';
import { OsmParking } from '../types/parking';
import { formatDistance } from '../utils/geo';
import { parkingFeeStatus, parkingName } from '../utils/parking';
import { PARKING_ACCENT, PARKING_ACCENT_DEEP } from './ParkingMarker';
import { AppIcon } from './AppIcon';

interface Props {
  parking:        OsmParking;
  distanceMeters: number;
  onPress:        () => void;
}

// ─── NearbyParkingSuggestion ──────────────────────────────────────────────────
// A driving aid: surfaces the closest known parking area to the user's live
// position so they don't have to take their eyes off the road to pan/zoom the
// map looking for one. MapScreen recomputes this from `userLocation` as the
// driver moves and swaps the card to whichever area is currently nearest —
// effectively "feeding" new options automatically while underway.
//
// Deliberately a single, calm suggestion rather than a list: while driving,
// one clear "go here" beats several options to weigh. Tapping it does exactly
// what tapping the marker would — opens the same detail sheet with the same
// "navigate" action — so there's nothing new to learn.
export const NearbyParkingSuggestion: React.FC<Props> = ({ parking, distanceMeters, onPress }) => {
  const fee = parkingFeeStatus(parking.tags);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={styles.card}
    >
      <View style={styles.badge}>
        <Text style={styles.glyph}>P</Text>
      </View>
      <View style={styles.textCol}>
        <Text style={styles.title} numberOfLines={1}>
          Nearest Parking · {formatDistance(distanceMeters / 1000)}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {parkingName(parking)}
          {fee === 'free' ? ' · Free' : ''}
          {fee === 'paid' ? ' · Paid' : ''}
          {fee === 'unknown' ? ' · Fee unknown' : ''}
        </Text>
      </View>
      <AppIcon
        name="chevron-forward"
        size={20}
        color={PARKING_ACCENT_DEEP}
        style={styles.chevron}
      />
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             10,
    backgroundColor: '#ffffff',
    borderRadius:    18,
    paddingVertical: 10,
    paddingHorizontal: 14,
    shadowColor:     '#0F172A',
    shadowOffset:    { width: 0, height: 4 },
    shadowOpacity:   0.18,
    shadowRadius:    10,
    elevation:       Platform.OS === 'android' ? 6 : 0,
  },
  badge: {
    width:           32,
    height:          32,
    borderRadius:    16,
    backgroundColor: PARKING_ACCENT,
    justifyContent:  'center',
    alignItems:      'center',
  },
  glyph: {
    color:      '#ffffff',
    fontSize:   14,
    fontWeight: '800',
  },
  textCol: { flex: 1 },
  title: {
    fontSize:   13,
    fontWeight: '700',
    color:      '#0F172A',
  },
  subtitle: {
    fontSize:   12,
    fontWeight: '500',
    color:      '#64748B',
    marginTop:  1,
  },
  chevron: {
    marginLeft: 2,
  },
});
