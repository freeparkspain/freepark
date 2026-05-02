import React from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';

interface Props {
  visible: boolean;
}

export const LoadingOverlay: React.FC<Props> = ({ visible }) => {
  if (!visible) return null;
  return (
    <View style={styles.container}>
      <ActivityIndicator size="small" color="#007AFF" />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position:        'absolute',
    top:             56,
    alignSelf:       'center',
    backgroundColor: '#ffffff',
    borderRadius:    20,
    width:           36,
    height:          36,
    justifyContent:  'center',
    alignItems:      'center',
    shadowColor:     '#000',
    shadowOffset:    { width: 0, height: 2 },
    shadowOpacity:   0.15,
    shadowRadius:    6,
    elevation:       8,
    zIndex:          9999,
  },
});
