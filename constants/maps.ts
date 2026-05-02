// Вставьте сюда ключ Google Maps Directions API.
// Нужен только для построения маршрутов — OSM-тайлы и маркеры работают без него.
// Получить: https://console.cloud.google.com/ → Directions API
export const MAPS_APIKEY = '';

// Цвета линий по типу парковки (стиль Mapy.cz / Google Maps)
export const PARKING_STROKE: Record<string, string> = {
  free:    '#4285F4',  // синий — бесплатная
  paid:    '#EF4444',  // красный — платная
  unknown: '#6B7280',  // серый — неизвестно
};
