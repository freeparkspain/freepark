import React, { memo } from 'react';
import type { ComponentProps } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

export type AppIconName = ComponentProps<typeof Ionicons>['name'];

interface Props {
  name: AppIconName;
  size?: number;
  color?: string;
  style?: StyleProp<TextStyle>;
}

/**
 * FreePark's single UI icon primitive. Ionicons keeps the glyph geometry and
 * baseline consistent across iOS, Android and web; callers only choose the
 * semantic icon, size and existing UI colour.
 */
export const AppIcon = memo(({ name, size = 20, color = '#0A67D8', style }: Props) => (
  <Ionicons
    name={name}
    size={size}
    color={color}
    style={style}
    accessible={false}
  />
));

AppIcon.displayName = 'AppIcon';
