/**
 * parking-layer.js
 *
 * Вставьте в проект после инициализации карты Leaflet.
 * Единственная зависимость — переменная `map` (L.Map instance).
 *
 * Использование:
 *   const parking = new ParkingLayer(map);
 *   parking.load();             // первоначальная загрузка (вызывается автоматически)
 *   parking.clearActiveZone();  // снять выделение вручную
 */

// ─────────────────────────────────────────────────────────────────────────────
// Конфигурация
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  overpassUrl:    'https://overpass-api.de/api/interpreter',
  debounceMs:     600,      // задержка после moveend перед запросом
  cacheMaxSize:   30,       // максимум записей в кэше
  cachePrecision: 3,        // точность bbox-ключа (≈111 м)
  minZoom:        13,       // ниже этого зума не делаем запрос
  polygonStyle: {
    color:       '#4285F4',
    fillColor:   '#4285F4',
    fillOpacity: 0.18,
    weight:      2.5,
  },
  circleFallbackRadius: 40, // метры — для точечных парковок без полигона
};

// ─────────────────────────────────────────────────────────────────────────────
// Кастомная иконка «P»
// ─────────────────────────────────────────────────────────────────────────────
const P_ICON = L.divIcon({
  className: '',
  html: `<div style="
    width:32px; height:32px; border-radius:50%;
    background:#3B82F6; border:2.5px solid #fff;
    display:flex; align-items:center; justify-content:center;
    color:#fff; font-weight:800; font-size:14px; font-family:sans-serif;
    box-shadow:0 2px 6px rgba(0,0,0,0.35); cursor:pointer;
    transition:transform .15s;
  ">P</div>`,
  iconSize:    [32, 32],
  iconAnchor:  [16, 16],
  popupAnchor: [0, -20],
});

// ─────────────────────────────────────────────────────────────────────────────
// ParkingLayer — основной класс
// ─────────────────────────────────────────────────────────────────────────────
class ParkingLayer {
  #map;
  #markersLayer;
  #activePolygon = null;
  #activeId      = null;
  #cache         = new Map();
  #debounceTimer = null;

  constructor(map) {
    this.#map          = map;
    this.#markersLayer = L.layerGroup().addTo(map);

    map.on('moveend', () => this.#onMapMove());
    this.load();
  }

  // ── Публичные методы ───────────────────────────────────────────────────────

  async load() {
    if (this.#map.getZoom() < CONFIG.minZoom) return;

    const bounds   = this.#map.getBounds();
    const cacheKey = this.#boundsToKey(bounds);

    let parkings = this.#cache.get(cacheKey);

    if (!parkings) {
      try {
        const raw = await this.#fetchOverpass(bounds);
        parkings  = this.#parseOverpassData(raw);
        this.#setCache(cacheKey, parkings);
      } catch (err) {
        console.error('[ParkingLayer] Ошибка загрузки:', err);
        return;
      }
    }

    this.#renderMarkers(parkings);
  }

  clearActiveZone() {
    if (this.#activePolygon) {
      this.#map.removeLayer(this.#activePolygon);
      this.#activePolygon = null;
    }
    this.#activeId = null;
  }

  // ── Приватные: события карты ───────────────────────────────────────────────

  #onMapMove() {
    clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => this.load(), CONFIG.debounceMs);
  }

  // ── 1. Загрузка данных из Overpass API ────────────────────────────────────

  async #fetchOverpass(bounds) {
    const { s, w, n, e } = this.#boundsValues(bounds);

    const query = `
      [out:json][timeout:25];
      (
        node["amenity"="parking"](${s},${w},${n},${e});
        way["amenity"="parking"](${s},${w},${n},${e});
        relation["amenity"="parking"](${s},${w},${n},${e});
      );
      out center geom;
    `.trim();

    const res = await fetch(
      `${CONFIG.overpassUrl}?data=${encodeURIComponent(query)}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ── 2. Парсинг ответа Overpass ────────────────────────────────────────────

  #parseOverpassData(data) {
    return data.elements.map(el => this.#parseElement(el)).filter(Boolean);
  }

  #parseElement(el) {
    if (el.type === 'node') {
      return {
        id:       `n${el.id}`,
        position: [el.lat, el.lon],
        polygon:  null,
        tags:     el.tags ?? {},
      };
    }

    if (el.type === 'way') {
      const coords = (el.geometry ?? []).map(g => [g.lat, g.lon]);
      const center = el.center ?? this.#computeCenter(coords);
      return {
        id:       `w${el.id}`,
        position: [center.lat, center.lon],
        polygon:  coords.length >= 3 ? coords : null,
        tags:     el.tags ?? {},
      };
    }

    if (el.type === 'relation') {
      // Берём первый outer-контур (внешняя граница мультиполигона)
      const outer  = el.members?.find(m => m.type === 'way' && m.role === 'outer');
      const coords = (outer?.geometry ?? []).map(g => [g.lat, g.lon]);
      const center = el.center ?? this.#computeCenter(coords);
      return {
        id:       `r${el.id}`,
        position: [center.lat, center.lon],
        polygon:  coords.length >= 3 ? coords : null,
        tags:     el.tags ?? {},
      };
    }

    return null;
  }

  // ── 3. Отрисовка маркеров ─────────────────────────────────────────────────

  #renderMarkers(parkings) {
    this.#markersLayer.clearLayers();

    parkings.forEach(parking => {
      L.marker(parking.position, { icon: P_ICON })
        .on('click', () => this.#handleMarkerClick(parking))
        .addTo(this.#markersLayer);
    });
  }

  // ── 4. Клик по маркеру — управление активной зоной ───────────────────────

  #handleMarkerClick(parking) {
    // Повторный клик на тот же маркер — снимаем выделение
    if (this.#activeId === parking.id) {
      this.clearActiveZone();
      return;
    }

    this.clearActiveZone();
    this.#activeId = parking.id;

    if (parking.polygon) {
      this.#activePolygon = L.polygon(parking.polygon, CONFIG.polygonStyle)
        .addTo(this.#map);
    } else {
      // Fallback: небольшой круг для точечных парковок
      this.#activePolygon = L.circle(parking.position, {
        ...CONFIG.polygonStyle,
        radius: CONFIG.circleFallbackRadius,
      }).addTo(this.#map);
    }
  }

  // ── Вспомогательные методы ────────────────────────────────────────────────

  #computeCenter(coords) {
    if (!coords.length) return { lat: 0, lon: 0 };
    const sum = coords.reduce(
      (acc, [lat, lon]) => ({ lat: acc.lat + lat, lon: acc.lon + lon }),
      { lat: 0, lon: 0 }
    );
    return { lat: sum.lat / coords.length, lon: sum.lon / coords.length };
  }

  #boundsValues(bounds) {
    return {
      s: bounds.getSouth(),
      w: bounds.getWest(),
      n: bounds.getNorth(),
      e: bounds.getEast(),
    };
  }

  #boundsToKey(bounds) {
    const p = CONFIG.cachePrecision;
    const { s, w, n, e } = this.#boundsValues(bounds);
    return `${s.toFixed(p)},${w.toFixed(p)},${n.toFixed(p)},${e.toFixed(p)}`;
  }

  #setCache(key, value) {
    this.#cache.set(key, value);
    // Вытесняем самую старую запись при переполнении
    if (this.#cache.size > CONFIG.cacheMaxSize) {
      this.#cache.delete(this.#cache.keys().next().value);
    }
  }
}
