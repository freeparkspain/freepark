import React, { useEffect, useRef } from 'react';
import {
  Animated, Platform, StyleSheet,
  Text, TouchableOpacity, View,
} from 'react-native';
import { SelectedDestination, RouteInfo, LatLng } from '../types/parking';
import { formatDistance, formatDuration, haversineDistance } from '../utils/geo';
import type { ParkingFeeStatus } from '../utils/parking';
import { AppIcon, AppIconName } from './AppIcon';

interface Props {
  destination:       SelectedDestination | null;
  /** Explicit OSM fee classification; missing tags remain honestly unknown. */
  parkingFeeStatus?: ParkingFeeStatus | null;
  parkingAccessLabel?: string | null;
  parkingAccessLoading?: boolean;
  previewStatus:     'idle' | 'building' | 'ready' | 'error';
  routeInfo:         RouteInfo | null;
  userLocation:      LatLng | null;
  canNavigate:       boolean;
  routeError:        string | null;
  locationDenied:    boolean;
  onPreviewRoute:    () => void;
  onStartRoute:      () => void;
  onRequestLocation: () => void;
  onClose:           () => void;
}

// Compact two-stage sheet: show the full route first, then explicitly start
// turn-by-turn guidance without covering much of the map.
export const SHEET_HEIGHT = Platform.OS === 'ios' ? 264 : 248;
const ACCENT              = '#007AFF';

const TYPE_ICON: Record<SelectedDestination['type'], AppIconName> = {
  parking: 'car-outline',
  search:  'search-outline',
  pin:     'location-outline',
};

export const RouteBottomSheet: React.FC<Props> = ({
  destination, parkingFeeStatus, parkingAccessLabel, parkingAccessLoading = false,
  previewStatus, routeInfo, userLocation, canNavigate, routeError,
  locationDenied, onPreviewRoute, onStartRoute, onRequestLocation, onClose,
}) => {
  const translateY = useRef(new Animated.Value(SHEET_HEIGHT)).current;

  useEffect(() => {
    Animated.spring(translateY, {
      toValue:         destination ? 0 : SHEET_HEIGHT,
      // Damping ratio ζ = friction / (2·√tension) — the old friction:9 at this
      // tension gives ζ≈0.41 (well under 1, i.e. underdamped), so the sheet
      // visibly overshot and bounced once before settling on every open/close.
      // friction:20 brings ζ≈0.91 (just under critical) — a fast, fluid slide
      // with no visible bounce.
      friction:        20,
      tension:         120,
      useNativeDriver: true,
    }).start();
  }, [destination, translateY]);

  const straightDist = destination && userLocation
    ? haversineDistance(userLocation, destination.position)
    : null;

  // Location is acquired on demand. Parking waits for its final route target so
  // the preview and the navigation session always share the same destination.
  const previewDisabled = !canNavigate || parkingAccessLoading;
  const previewLabel = parkingAccessLoading
    ? 'Preparing destination…'
    : !canNavigate
      ? 'No route provider configured'
      : 'Show Route';
  const previewIcon: AppIconName = !canNavigate ? 'settings-outline' : 'map-outline';

  return (
    <Animated.View
      style={[styles.sheet, { transform: [{ translateY }] }]}
      pointerEvents={destination ? 'box-none' : 'none'}
    >
      {destination && (
        <>
          <View style={styles.handle} />

          <View style={styles.header}>
            <View style={styles.typeIcon}>
              <AppIcon name={TYPE_ICON[destination.type]} size={19} color="#0A67D8" />
            </View>
            <Text style={styles.title} numberOfLines={1}>{destination.title}</Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel="Close destination details"
            >
              <AppIcon name="close" size={21} color="#64748B" />
            </TouchableOpacity>
          </View>

          {/* Paid/free badge — only for parking destinations, from existing OSM
              tags (no invented data). Blue = free, orange = paid (matches map). */}
          {destination.type === 'parking' && parkingFeeStatus != null && (
            <View style={[
              styles.parkingBadge,
              parkingFeeStatus === 'paid'
                ? styles.parkingBadgePaid
                : parkingFeeStatus === 'free'
                  ? styles.parkingBadgeFree
                  : styles.parkingBadgeUnknown,
            ]}>
              <Text style={[
                styles.parkingBadgeText,
                parkingFeeStatus === 'paid'
                  ? styles.parkingBadgeTextPaid
                  : parkingFeeStatus === 'free'
                    ? styles.parkingBadgeTextFree
                    : styles.parkingBadgeTextUnknown,
              ]}>
                {parkingFeeStatus === 'paid'
                  ? '€ Paid parking'
                  : parkingFeeStatus === 'free'
                    ? 'P Free parking'
                    : 'P Fee unknown'}
              </Text>
            </View>
          )}

          {destination.type === 'parking' && (parkingAccessLoading || parkingAccessLabel) && (
            <View style={styles.accessRow}>
              <View style={styles.accessDot} />
              <Text style={styles.accessText} numberOfLines={1}>
                {parkingAccessLoading ? 'Preparing route destination…' : parkingAccessLabel}
              </Text>
            </View>
          )}

          {previewStatus === 'idle' && (
            <>
              {straightDist !== null ? (
                <Text style={styles.distance}>
                  {formatDistance(straightDist / 1000)} straight line
                </Text>
              ) : locationDenied ? (
                <TouchableOpacity onPress={onRequestLocation} activeOpacity={0.7}>
                  <View style={styles.locationHint}>
                    <AppIcon name="location-outline" size={17} color="#92400E" />
                    <Text style={styles.locationHintText}>
                      Location is off — tap to enable for in-app routing
                    </Text>
                  </View>
                </TouchableOpacity>
              ) : (
                <View style={styles.inlineStatus}>
                  <AppIcon name="locate-outline" size={16} color="#64748B" />
                  <Text style={styles.distanceText}>Locating you…</Text>
                </View>
              )}

              <TouchableOpacity
                style={[styles.routeBtn, { backgroundColor: previewDisabled ? '#9CA3AF' : ACCENT }]}
                onPress={previewDisabled ? undefined : onPreviewRoute}
                activeOpacity={previewDisabled ? 1 : 0.85}
                disabled={previewDisabled}
              >
                <AppIcon name={previewIcon} size={19} color="#FFFFFF" />
                <Text style={styles.routeBtnText}>{previewLabel}</Text>
              </TouchableOpacity>
            </>
          )}

          {previewStatus === 'building' && (
            <View style={styles.calculating}>
              <AppIcon name="time-outline" size={17} color="#64748B" />
              <Text style={styles.calculatingText}>Building route…</Text>
            </View>
          )}

          {previewStatus === 'error' && (
            <>
              <View style={styles.errorBox}>
                <AppIcon name="warning-outline" size={17} color="#92400E" />
                <Text style={styles.errorText}>{routeError || 'Route unavailable'}</Text>
              </View>
              <TouchableOpacity style={styles.routeBtn} onPress={onPreviewRoute} activeOpacity={0.85}>
                <AppIcon name="refresh-outline" size={19} color="#FFFFFF" />
                <Text style={styles.routeBtnText}>Try Again</Text>
              </TouchableOpacity>
            </>
          )}

          {previewStatus === 'ready' && routeInfo && (
            <>
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
              <TouchableOpacity style={styles.routeBtn} onPress={onStartRoute} activeOpacity={0.85}>
                <AppIcon name="navigate" size={19} color="#FFFFFF" />
                <Text style={styles.routeBtnText}>Start Navigation</Text>
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
  typeIcon:  {
    width: 28, height: 28, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#EFF6FF',
  },
  title:     { flex: 1, fontSize: 15, fontWeight: '700', color: '#111827' },
  distance:  { fontSize: 13, color: '#6B7280', marginBottom: 10 },
  distanceText: { fontSize: 13, color: '#6B7280' },
  inlineStatus: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10,
  },
  parkingBadge: {
    alignSelf: 'flex-start',
    borderRadius: 8, paddingVertical: 3, paddingHorizontal: 8,
    marginBottom: 8,
  },
  parkingBadgeFree: { backgroundColor: '#DBEAFE' },
  parkingBadgePaid: { backgroundColor: '#FFEDD5' },
  parkingBadgeUnknown: { backgroundColor: '#F1F5F9' },
  parkingBadgeText: { fontSize: 12, fontWeight: '700' },
  parkingBadgeTextFree: { color: '#1D4ED8' },
  parkingBadgeTextPaid: { color: '#C2410C' },
  parkingBadgeTextUnknown: { color: '#475569' },
  accessRow: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    marginTop: -2, marginBottom: 7,
  },
  accessDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#007AFF',
  },
  accessText: { flex: 1, fontSize: 12, fontWeight: '600', color: '#475569' },
  locationHint: {
    flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10,
    backgroundColor: '#FEF3C7', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10,
  },
  locationHintText: { flex: 1, fontSize: 13, color: '#92400E' },
  routeBtn:  {
    backgroundColor: ACCENT,
    borderRadius: 14, paddingVertical: 13, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 8, marginBottom: 8,
  },
  routeBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  gmapsBtn: {
    borderRadius: 14, paddingVertical: 11,
    alignItems: 'center', borderWidth: 1.5, borderColor: '#34A853',
  },
  gmapsBtnText: { color: '#34A853', fontSize: 14, fontWeight: '600' },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: '#FEF9C3', borderRadius: 8, padding: 8, marginBottom: 10,
  },
  errorText: { flexShrink: 1, fontSize: 13, color: '#92400E', textAlign: 'center' },
  etaRow: {
    flexDirection: 'row', justifyContent: 'center',
    alignItems: 'center', marginBottom: 10, marginTop: 2,
  },
  etaCard:      { flex: 1, alignItems: 'center' },
  etaSep:       { width: 1, height: 38, backgroundColor: '#E5E7EB' },
  etaValue:     { fontSize: 21, fontWeight: '800', color: '#111827' },
  etaLabel:     { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  calculating:  {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    marginVertical: 10,
  },
  calculatingText: { fontSize: 14, color: '#64748B' },
  cancelBtn:    {
    backgroundColor: '#FEE2E2', borderRadius: 14, paddingVertical: 13,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    marginBottom: 8,
  },
  cancelBtnText:{ color: '#DC2626', fontSize: 15, fontWeight: '700' },
});
