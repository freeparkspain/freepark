import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MapScreen } from '../screens/MapScreen';
import { ParkingDetailsScreen } from '../screens/ParkingDetailsScreen';
import { RootStackParamList } from '../types/parking';

const Stack = createNativeStackNavigator<RootStackParamList>();

export const Navigation: React.FC = () => (
  <NavigationContainer>
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#3B82F6' },
        headerTintColor: '#ffffff',
        headerTitleStyle: { fontWeight: 'bold' },
        headerTitleAlign: 'center',
      }}
    >
      <Stack.Screen
        name="Map"
        component={MapScreen}
        options={{ title: 'FreePark' }}
      />
      <Stack.Screen
        name="ParkingDetails"
        component={ParkingDetailsScreen}
        options={{ title: 'Parking Details' }}
      />
    </Stack.Navigator>
  </NavigationContainer>
);
