import React, { useEffect, useRef } from 'react';
import { Animated, Dimensions, StyleSheet, View } from 'react-native';

interface Props { visible: boolean; }

const SCREEN_W = Dimensions.get('window').width;
const BAR_W    = Math.round(SCREEN_W * 0.45); // sliding segment is 45 % of screen

export const GeometryLoadingBar: React.FC<Props> = ({ visible }) => {
  const translateX  = useRef(new Animated.Value(-BAR_W)).current;
  const animLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (!visible) {
      animLoopRef.current?.stop();
      translateX.setValue(-BAR_W);
      return;
    }

    // Always start from the left edge so the bar appears immediately
    translateX.setValue(-BAR_W);

    animLoopRef.current = Animated.loop(
      Animated.timing(translateX, {
        toValue:         SCREEN_W + BAR_W,
        duration:        1_200,
        useNativeDriver: true,
      }),
    );
    animLoopRef.current.start();

    return () => animLoopRef.current?.stop();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible) return null;

  return (
    // pointerEvents="none" so the bar never intercepts map touches
    <View style={styles.track} pointerEvents="none">
      <Animated.View
        style={[styles.bar, { transform: [{ translateX }] }]}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  track: {
    position:        'absolute',
    top:             0,
    left:            0,
    right:           0,
    height:          3,
    overflow:        'hidden',
    backgroundColor: 'rgba(0,122,255,0.12)',
    zIndex:          9999,
  },
  bar: {
    position:        'absolute',
    left:            0,
    top:             0,
    height:          3,
    width:           BAR_W,
    backgroundColor: '#007AFF',
    borderRadius:    1.5,
  },
});
