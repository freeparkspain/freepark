import React, { useEffect, useRef } from 'react';
import {
  Animated, Platform, StyleSheet,
  Text, TouchableOpacity, View,
} from 'react-native';
import { SelectedDestination, RouteInfo, LatLng } from '../types/parking';
import { formatDistance, formatDuration, haversineDistance } from '../utils/geo';

interface Props {
  destination:       SelectedDestination | null;
  activeRoute:       boolean;
  routeInfo:         RouteInfo | null;
  userLocation:      LatLng | null;
  canNavigate:       boolean;
  routeError:        string | null;
  locationDenied:    boolean;
  onStartRoute:      () => void;
  onCancelRoute:     () => void;
  onRequestLocation: () => void;
  onClose:           () => void;
}

// Compact sheet — the destination card only needs the title, one distance line
// and the Start Route button, so keep it short and low so it covers little map.
export const SHEET_HEIGHT = 196;
const ACCENT              = '#007AFF';

const TYPE_ICON: Record<SelectedDestination['type'], string> = {
  parking: '🅿️',
  search:  '🔍',
  pin:     '📍',
};

export const RouteBottomSheet: React.FC<Props> = ({
  destination, activeRoute, routeInfo, userLocation, canNavigate, routeError,
  locationDenied, onStartRoute, onCancelRoute, onRequestLocation, onClose,
}) => {
  const translateY = useRef(new Animated.Value(SHEET_HEIGHT)).current;

  useEffect(() => {
    Animated.spring(translateY, {
      toValue:         destination ? 0 : SHEET_HEIGHT,
      friction:        9,
      tension:         120,
      useNativeDriver: true,
    }).start();
  }, [destination, translateY]);

  const straightDist = destination && userLocation
    ? haversineDistance(userLocation, destination.position)
    : null;

  // Start Route stays enabled as long as an in-app provider exists — it
  // acquires the location on demand when pressed, so we never sit disabled on
  // "Waiting for location…". It's only truly blocked with no provider at all.
  const startDisabled = !canNavigate;
  const startLabel    = !canNavigate
    ? '⚙️ No route provider configured'
    : '🗺 Start Route';

  return (
    <Animated.View
      style={[styles.sheet, { transform: [{ translateY }] }]}
      pointerEvents={destination ? 'box-none' : 'none'}
    >
      {destination && (
        <>
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.typeIcon}>{TYPE_ICON[destination.type]}</Text>
            <Text style={styles.title} numberOfLines={1}>{destination.title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={styles.closeIcon}>✕</Text>
            </TouchableOpacity>
          </View>

          {!activeRoute ? (
            <>
              {straightDist !== null ? (
                <Text style={styles.distance}>
                  {formatDistance(straightDist / 1000)} straight line
                </Text>
              ) : locationDenied ? (
                <TouchableOpacity onPress={onRequestLocation} activeOpacity={0.7}>
                  <Text style={styles.locationHint}>
                    📍 Location is off — tap to enable for in-app routing
                  </Text>
                </TouchableOpacity>
              ) : (
                <Text style={styles.distance}>📍 Locating you…</Text>
              )}

              <TouchableOpacity
                style={[styles.routeBtn, { backgroundColor: startDisabled ? '#9CA3AF' : ACCENT }]}
                onPress={startDisabled ? undefined : onStartRoute}
                activeOpacity={startDisabled ? 1 : 0.85}
                disabled={startDisabled}
              >
                <Text style={styles.routeBtnText}>{startLabel}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              {routeError ? (
                <Text style={styles.errorText}>⚠️ Route unavailable · showing direct line</Text>
              ) : routeInfo ? (
                <View style={styles.etaRow}>
                  <View style={styles.etaCard}>
                    <Text style={styles.etaValue}>{formatDistance(routeInfo.distance)}</Text>
                    <Text style={styles.etaLabel}>distance</Text>
                  </View>
                  <View style={styles.etaSep} />
                  <View style={styles.etaCard}>
                    <Text style={styles.etaValue}>{formatDuration(routeInfo.duration)}</Text>
                    <Text style={styles.etaLabel}>travel time</Text>
                  </View>
                </View>
              ) : (
                <Text style={styles.calculating}>⏳ Calculating route…</Text>
              )}

              <TouchableOpacity style={styles.cancelBtn} onPress={onCancelRoute} activeOpacity={0.85}>
                <Text style={styles.cancelBtnText}>✕  Cancel Route</Text>
              </TouchableOpacity>
            </>
          )}
        </>
      )}
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  sheet: {
    position:             'absolute',
    bottom: 0, left: 0, right: 0,
    height:               SHEET_HEIGHT,
    backgroundColor:      '#ffffff',
    borderTopLeftRadius:  24,
    borderTopRightRadius: 24,
    paddingHorizontal:    20,
    paddingBottom:        Platform.OS === 'ios' ? 28 : 16,
    shadowColor:          '#000',
    shadowOffset:         { width: 0, height: -4 },
    shadowOpacity:        0.10,
    shadowRadius:         12,
    elevation:            20,
    zIndex:               9999,
  },
  handle: {
    width: 44, height: 5, borderRadius: 3,
    backgroundColor: '#E5E7EB',
    alignSelf: 'center',
    marginTop: 10, marginBottom: 12,
  },
  header: {
    flexDirection: 'row', alignItems: 'center',
    gap: 8, marginBottom: 6,
  },
  typeIcon:  { fontSize: 16 },
  title:     { flex: 1, fontSize: 15, fontWeight: '700', color: '#111827' },
  closeIcon: { fontSize: 16, color: '#9CA3AF', paddingLeft: 8 },
  distance:  { fontSize: 13, color: '#6B7280', marginBottom: 10 },
  locationHint: {
    fontSize: 13, color: '#92400E', marginBottom: 10,
    backgroundColor: '#FEF3C7', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10,
  },
  routeBtn:  { borderRadius: 14, paddingVertical: 13, alignItems: 'center', marginBottom: 8 },
  routeBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  gmapsBtn: {
    borderRadius: 14, paddingVertical: 11,
    alignItems: 'center', borderWidth: 1.5, borderColor: '#34A853',
  },
  gmapsBtnText: { color: '#34A853', fontSize: 14, fontWeight: '600' },
  errorText: {
    fontSize: 13, color: '#92400E', textAlign: 'center',
    backgroundColor: '#FEF9C3', borderRadius: 8, padding: 8, marginBottom: 10,
  },
  etaRow: {
    flexDirection: 'row', justifyContent: 'center',
    alignItems: 'center', marginBottom: 10, marginTop: 2,
  },
  etaCard:      { flex: 1, alignItems: 'center' },
  etaSep:       { width: 1, height: 38, backgroundColor: '#E5E7EB' },
  etaValue:     { fontSize: 21, fontWeight: '800', color: '#111827' },
  etaLabel:     { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  calculating:  { fontSize: 14, color: '#9CA3AF', textAlign: 'center', marginVertical: 10 },
  cancelBtn:    { backgroundColor: '#FEE2E2', borderRadius: 14, paddingVertical: 13, alignItems: 'center', marginBottom: 8 },
  cancelBtnText:{ color: '#DC2626', fontSize: 15, fontWeight: '700' },
});
