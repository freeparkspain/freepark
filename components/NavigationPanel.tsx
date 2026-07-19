import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NavigationState } from '../types/navigation';
import { formatDistanceEn, formatDurationEn } from '../navigation/format';
import { AppIcon, AppIconName } from './AppIcon';

interface Props {
  state:        NavigationState;
  onStop:       () => void;
  onToggleMute: () => void;
  onRecenter:   () => void;
  onRetry?:     () => void;
}

interface ManeuverIcon {
  name: AppIconName;
  rotation?: '-45deg' | '45deg';
}

function maneuverIcon(type: string, modifier: string | null): ManeuverIcon {
  if (type === 'arrive') return { name: 'flag' };
  if (type === 'depart') return { name: 'navigate' };
  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') {
    return { name: 'sync' };
  }
  switch (modifier) {
    case 'left':         return { name: 'arrow-back' };
    case 'right':        return { name: 'arrow-forward' };
    case 'slight left':  return { name: 'arrow-up', rotation: '-45deg' };
    case 'slight right': return { name: 'arrow-up', rotation: '45deg' };
    case 'sharp left':   return { name: 'return-up-back' };
    case 'sharp right':  return { name: 'return-up-forward' };
    case 'uturn':        return { name: 'return-up-back' };
    default:             return { name: 'arrow-up' };
  }
}

// 12-hour local clock, e.g. "4:47 PM".
function etaText(epochMs: number): string {
  const d = new Date(epochMs);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m} ${suffix}`;
}

export const NavigationPanel: React.FC<Props> = ({
  state, onStop, onToggleMute, onRecenter, onRetry,
}) => {
  const insets = useSafeAreaInsets();
  if (state.kind === 'idle') return null;

  const topOffset    = insets.top + 8;
  const bottomOffset = insets.bottom + 12;

  // ── Transient / terminal states ────────────────────────────────────────────
  if (state.kind === 'requestingLocation' || state.kind === 'buildingRoute') {
    const label = state.kind === 'requestingLocation'
      ? 'Finding your location…'
      : 'Building route…';
    return (
      <View style={styles.centerWrap} pointerEvents="box-none">
        <View style={styles.statusCard}>
          <ActivityIndicator color="#007AFF" />
          <Text style={styles.statusText}>{label}</Text>
          <TouchableOpacity onPress={onStop} hitSlop={hit}>
            <Text style={styles.statusCancel}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (state.kind === 'error') {
    return (
      <View style={styles.centerWrap} pointerEvents="box-none">
        <View style={[styles.statusCard, styles.errorCard]}>
          <View style={styles.errorMessageRow}>
            <AppIcon name="alert-circle" size={22} color="#DC2626" />
            <Text style={styles.errorText}>{state.message}</Text>
          </View>
          <View style={styles.errorActions}>
            {state.recoverable && onRetry && (
              <TouchableOpacity style={styles.retryBtn} onPress={onRetry}>
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.closeBtn} onPress={onStop}>
              <Text style={styles.closeText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  if (state.kind === 'arrived') {
    return (
      <View style={styles.centerWrap} pointerEvents="box-none">
        <View style={styles.statusCard}>
          <View style={styles.arrivedRow}>
            <AppIcon name="flag" size={24} color="#0A67D8" />
            <Text style={styles.arrivedText}>You have arrived</Text>
          </View>
          <TouchableOpacity style={styles.closeBtn} onPress={onStop}>
            <Text style={styles.closeText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Active navigation ────────────────────────────────────────────────────────
  const maneuver = maneuverIcon(state.maneuverType, state.maneuverModifier);

  return (
    <>
      {/* Top maneuver banner — compact, anchored to the top safe area so it
          reads at a glance without covering much of the map (BUG 7). */}
      <View style={[styles.topBanner, { top: topOffset }]} pointerEvents="box-none">
        <View style={styles.bannerRow}>
          <View style={styles.icon}>
            <AppIcon
              name={maneuver.name}
              size={38}
              color="#FFFFFF"
              style={maneuver.rotation
                ? { transform: [{ rotate: maneuver.rotation }] }
                : undefined}
            />
          </View>
          <View style={styles.bannerTextCol}>
            <Text style={styles.distanceToTurn}>
              {formatDistanceEn(state.distanceToNextManeuverMeters)}
            </Text>
            <Text style={styles.instruction} numberOfLines={2} ellipsizeMode="tail">
              {state.currentInstruction}
            </Text>
            {state.streetName ? (
              <Text style={styles.street} numberOfLines={1} ellipsizeMode="tail">
                {state.streetName}
              </Text>
            ) : null}
          </View>
        </View>
        {state.isRerouting && (
          <View style={styles.reroutePill}>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={styles.rerouteText}>Recalculating route…</Text>
          </View>
        )}
      </View>

      {/* Bottom trip bar — designed ETA / distance readout */}
      <View style={[styles.bottomBar, { bottom: bottomOffset }]} pointerEvents="box-none">
        <View style={styles.tripInfo}>
          <Text style={styles.tripTime} numberOfLines={1}>
            {formatDurationEn(state.remainingDurationSeconds)}
          </Text>
          <View style={styles.tripStatsRow}>
            <View style={styles.tripStat}>
              <Text style={styles.tripStatValue} numberOfLines={1}>
                {formatDistanceEn(state.remainingDistanceMeters)}
              </Text>
              <Text style={styles.tripStatLabel}>distance</Text>
            </View>
            <View style={styles.tripStatDivider} />
            <View style={styles.tripStat}>
              <Text style={styles.tripStatValue} numberOfLines={1}>
                {etaText(state.etaEpochMs)}
              </Text>
              <Text style={styles.tripStatLabel}>arrival</Text>
            </View>
          </View>
        </View>

        <View style={styles.controls}>
          <TouchableOpacity
            style={[styles.ctrlBtn, !state.isFollowingUser && styles.ctrlBtnActive]}
            onPress={onRecenter}
            hitSlop={hit}
            accessibilityLabel="Recenter map on your location"
          >
            <AppIcon
              name="locate"
              size={22}
              color={state.isFollowingUser ? '#64748B' : '#0A67D8'}
            />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.ctrlBtn}
            onPress={onToggleMute}
            hitSlop={hit}
            accessibilityLabel={state.isMuted ? 'Unmute voice guidance' : 'Mute voice guidance'}
          >
            <AppIcon
              name={state.isMuted ? 'volume-mute' : 'volume-high'}
              size={22}
              color={state.isMuted ? '#64748B' : '#0A67D8'}
            />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.endBtn}
            onPress={onStop}
            hitSlop={hit}
            accessibilityLabel="End navigation"
          >
            <Text style={styles.endText}>End</Text>
          </TouchableOpacity>
        </View>
      </View>
    </>
  );
};

const hit = { top: 10, bottom: 10, left: 10, right: 10 };

const styles = StyleSheet.create({
  // Compact top card: ~fixed 16 margin, small padding, ≤2-line instruction.
  topBanner: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: '#0A5FD6',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    zIndex: 10000,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
    elevation: 10,
  },
  bannerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  bannerTextCol: { flex: 1 },
  distanceToTurn: { color: '#fff', fontSize: 22, fontWeight: '800' },
  instruction: { color: '#fff', fontSize: 15, fontWeight: '600', marginTop: 1 },
  street: { color: '#CFE0FF', fontSize: 12, marginTop: 1 },
  reroutePill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 10, alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5,
  },
  rerouteText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  bottomBar: {
    position: 'absolute',
    left: 12,
    right: 12,
    backgroundColor: '#ffffff',
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 10000,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 12,
  },
  tripInfo: { flex: 1, marginRight: 10 },
  // Big prominent remaining time in the accent colour, then a clean stats row.
  tripTime: { fontSize: 24, fontWeight: '800', color: '#2563EB', letterSpacing: -0.3 },
  tripStatsRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  tripStat: { alignItems: 'flex-start' },
  tripStatValue: { fontSize: 15, fontWeight: '700', color: '#111827' },
  tripStatLabel: { fontSize: 10, fontWeight: '600', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.4 },
  tripStatDivider: { width: 1, height: 26, backgroundColor: '#E5E7EB', marginHorizontal: 14 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ctrlBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center',
  },
  ctrlBtnActive: { backgroundColor: '#DBEAFE' },
  endBtn: {
    backgroundColor: '#FEE2E2', borderRadius: 22,
    paddingHorizontal: 16, height: 44, alignItems: 'center', justifyContent: 'center',
  },
  endText: { color: '#DC2626', fontSize: 14, fontWeight: '800' },

  centerWrap: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', zIndex: 10000,
  },
  statusCard: {
    backgroundColor: '#fff', borderRadius: 18, paddingHorizontal: 24, paddingVertical: 20,
    alignItems: 'center', gap: 12, minWidth: 240,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2, shadowRadius: 12, elevation: 12,
  },
  statusText: { fontSize: 15, fontWeight: '600', color: '#111827' },
  statusCancel: { fontSize: 14, color: '#6B7280', marginTop: 4 },
  errorCard: { borderWidth: 1, borderColor: '#FCA5A5' },
  errorMessageRow: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 300 },
  errorText: { flexShrink: 1, fontSize: 14, color: '#991B1B', textAlign: 'center', fontWeight: '600' },
  errorActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  retryBtn: { backgroundColor: '#007AFF', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 },
  retryText: { color: '#fff', fontWeight: '700' },
  closeBtn: { backgroundColor: '#F3F4F6', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 },
  closeText: { color: '#374151', fontWeight: '700' },
  arrivedRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  arrivedText: { fontSize: 18, fontWeight: '800', color: '#0A67D8' },
});
