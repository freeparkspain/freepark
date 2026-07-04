import React, { useEffect, useRef } from 'react';
import { Animated, View, Text, TouchableOpacity, StyleSheet, Platform, Linking } from 'react-native';
import { OsmParking, RouteInfo, LatLng } from '../types/parking';
import { formatDistance, formatDuration, haversineDistance } from '../utils/geo';

interface Props {
  parking:      OsmParking | null;
  activeRoute:  boolean;
  routeInfo:    RouteInfo | null;
  userLocation: LatLng | null;
  hasApiKey:    boolean;
  onStartRoute: () => void;
  onCancelRoute: () => void;
  onClose:      () => void;
}

export const SHEET_HEIGHT = 240;
const ACCENT       = '#007AFF';

/** Имя парковки из OSM-тегов */
function parkingName(p: OsmParking): string {
  return p.tags.name ?? p.tags['name:ru'] ?? p.tags['name:en'] ?? 'Парковка';
}

/** Адрес из OSM-тегов */
function parkingAddress(p: OsmParking): string | null {
  const street = p.tags['addr:street'];
  const city   = p.tags['addr:city'];
  if (street && city) return `${street}, ${city}`;
  if (street) return street;
  return null;
}

// Without a Directions key, MAPS_APIKEY is '' — the in-app route preview
// (polyline + ETA card) simply can't run. Telling the *driver* to go edit a
// source file is a dead end, not a feature; what they actually want is
// "take me there", and every phone already has a navigation app that does
// that better than an in-app polyline ever could (live traffic, voice
// guidance, lane assist). So this is the real "Go" for everyone — opening
// the device's own maps app needs no key and always works. The in-app
// preview above only supplements it on the rare device where a key exists.
function openExternalNavigation(destination: LatLng, label: string): void {
  const { latitude, longitude } = destination;
  const place    = encodeURIComponent(label);
  const url      = Platform.OS === 'ios'
    ? `maps://app?daddr=${latitude},${longitude}&q=${place}`
    : `geo:${latitude},${longitude}?q=${latitude},${longitude}(${place})`;
  const fallback = `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}&travelmode=driving`;

  Linking.canOpenURL(url)
    .then(supported => Linking.openURL(supported ? url : fallback))
    .catch(() => Linking.openURL(fallback));
}

/** Примечание: тип / платность из OSM-тегов */
function parkingNote(p: OsmParking): string | null {
  const parts: string[] = [];
  if (p.tags.fee === 'yes')  parts.push('Платная');
  if (p.tags.fee === 'no')   parts.push('Бесплатная');
  if (p.tags.capacity)       parts.push(`Мест: ${p.tags.capacity}`);
  if (p.tags.maxstay)        parts.push(`Макс: ${p.tags.maxstay}`);
  return parts.length ? parts.join(' · ') : null;
}

export const RouteBottomSheet: React.FC<Props> = ({
  parking, activeRoute, routeInfo, userLocation, hasApiKey,
  onStartRoute, onCancelRoute, onClose,
}) => {
  const translateY = useRef(new Animated.Value(SHEET_HEIGHT)).current;

  useEffect(() => {
    Animated.spring(translateY, {
      toValue:         parking ? 0 : SHEET_HEIGHT,
      friction:        9,
      tension:         120,
      useNativeDriver: true,
    }).start();
  }, [parking, translateY]);

  const straightDist = parking && userLocation
    ? haversineDistance(userLocation, parking.position)
    : null;

  return (
    <Animated.View
      style={[styles.sheet, { transform: [{ translateY }] }]}
      pointerEvents={parking ? 'box-none' : 'none'}
    >
      {parking && (
        <>
          <View style={styles.handle} />

          {/* Header */}
          <View style={styles.header}>
            <View style={[styles.dot, { backgroundColor: ACCENT }]} />
            <Text style={styles.title} numberOfLines={1}>{parkingName(parking)}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={styles.closeIcon}>✕</Text>
            </TouchableOpacity>
          </View>

          {!activeRoute ? (
            <>
              {parkingAddress(parking) && (
                <Text style={styles.meta} numberOfLines={1}>
                  📍 {parkingAddress(parking)}
                </Text>
              )}
              <Text style={styles.coords} numberOfLines={1}>
                {parking.position.latitude.toFixed(6)}, {parking.position.longitude.toFixed(6)}
              </Text>
              {parkingNote(parking) && (
                <Text style={styles.meta} numberOfLines={1}>
                  💡 {parkingNote(parking)}
                </Text>
              )}
              {straightDist !== null && (
                <Text style={styles.distance}>
                  {formatDistance(straightDist / 1000)}
                </Text>
              )}

              <View style={styles.actionsRow}>
                {hasApiKey && (
                  <TouchableOpacity
                    style={[styles.routeBtn, styles.routeBtnFlex, { backgroundColor: ACCENT }]}
                    onPress={onStartRoute}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.routeBtnText}>Поехали</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[
                    styles.routeBtn,
                    styles.routeBtnFlex,
                    hasApiKey
                      ? { backgroundColor: '#EFF6FF', borderWidth: 1, borderColor: '#BFDBFE' }
                      : { backgroundColor: ACCENT },
                  ]}
                  onPress={() => openExternalNavigation(parking.position, parkingName(parking))}
                  activeOpacity={0.85}
                >
                  <Text style={hasApiKey ? styles.routeBtnTextSecondary : styles.routeBtnText}>
                    🧭 Открыть в навигаторе
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              {routeInfo ? (
                <View style={styles.etaRow}>
                  <View style={styles.etaCard}>
                    <Text style={styles.etaValue}>{formatDistance(routeInfo.distance)}</Text>
                    <Text style={styles.etaLabel}>расстояние</Text>
                  </View>
                  <View style={styles.etaSep} />
                  <View style={styles.etaCard}>
                    <Text style={styles.etaValue}>{formatDuration(routeInfo.duration)}</Text>
                    <Text style={styles.etaLabel}>время в пути</Text>
                  </View>
                </View>
              ) : (
                <Text style={styles.calculating}>⏳ Строим маршрут…</Text>
              )}
              <TouchableOpacity style={styles.cancelBtn} onPress={onCancelRoute} activeOpacity={0.85}>
                <Text style={styles.cancelBtnText}>✕  Отменить маршрут</Text>
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
    marginTop: 10, marginBottom: 14,
  },
  header: {
    flexDirection: 'row', alignItems: 'center',
    gap: 10, marginBottom: 6,
  },
  dot:       { width: 12, height: 12, borderRadius: 6, flexShrink: 0 },
  title:     { flex: 1, fontSize: 16, fontWeight: '700', color: '#111827' },
  closeIcon: { fontSize: 16, color: '#9CA3AF', paddingLeft: 8 },
  meta:      { fontSize: 13, color: '#6B7280', marginBottom: 3 },
  coords:    { fontSize: 12, color: '#9CA3AF', marginBottom: 6 },
  distance:  { fontSize: 13, color: '#374151', fontWeight: '600', marginBottom: 10 },
  actionsRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  routeBtn:  { borderRadius: 16, paddingVertical: 14, alignItems: 'center' },
  routeBtnFlex: { flex: 1 },
  routeBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  routeBtnTextSecondary: { color: ACCENT, fontSize: 15, fontWeight: '700' },
  etaRow: {
    flexDirection: 'row', justifyContent: 'center',
    alignItems: 'center', marginBottom: 14, marginTop: 4,
  },
  etaCard:      { flex: 1, alignItems: 'center' },
  etaSep:       { width: 1, height: 40, backgroundColor: '#E5E7EB' },
  etaValue:     { fontSize: 22, fontWeight: '800', color: '#111827' },
  etaLabel:     { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  calculating:  { fontSize: 14, color: '#9CA3AF', textAlign: 'center', marginVertical: 12 },
  cancelBtn:    { backgroundColor: '#FEE2E2', borderRadius: 16, paddingVertical: 14, alignItems: 'center' },
  cancelBtnText:{ color: '#DC2626', fontSize: 15, fontWeight: '700' },
});
