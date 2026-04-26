/**
 * Hardcoded mapping from city name to (latitude, longitude). Phase 1 of
 * the weather strategy supports only this set; Phase 2 will fetch
 * coordinates from a geocoding API on demand.
 *
 * Names are matched case-insensitively. Aliases share the same
 * coordinates.
 */
export interface CityCoords {
  readonly latitude: number;
  readonly longitude: number;
  /** Canonical name for logging. */
  readonly displayName: string;
}

const RAW: Record<string, CityCoords> = {
  seoul: { latitude: 37.5665, longitude: 126.978, displayName: 'Seoul' },
  tokyo: { latitude: 35.6762, longitude: 139.6503, displayName: 'Tokyo' },
  beijing: { latitude: 39.9042, longitude: 116.4074, displayName: 'Beijing' },
  shanghai: { latitude: 31.2304, longitude: 121.4737, displayName: 'Shanghai' },
  shenzhen: { latitude: 22.5431, longitude: 114.0579, displayName: 'Shenzhen' },
  'hong kong': { latitude: 22.3193, longitude: 114.1694, displayName: 'Hong Kong' },
  singapore: { latitude: 1.3521, longitude: 103.8198, displayName: 'Singapore' },
  delhi: { latitude: 28.6139, longitude: 77.209, displayName: 'Delhi' },
  mumbai: { latitude: 19.076, longitude: 72.8777, displayName: 'Mumbai' },
  dubai: { latitude: 25.2048, longitude: 55.2708, displayName: 'Dubai' },

  london: { latitude: 51.5074, longitude: -0.1278, displayName: 'London' },
  paris: { latitude: 48.8566, longitude: 2.3522, displayName: 'Paris' },
  berlin: { latitude: 52.52, longitude: 13.405, displayName: 'Berlin' },
  madrid: { latitude: 40.4168, longitude: -3.7038, displayName: 'Madrid' },
  rome: { latitude: 41.9028, longitude: 12.4964, displayName: 'Rome' },
  moscow: { latitude: 55.7558, longitude: 37.6173, displayName: 'Moscow' },

  'new york': { latitude: 40.7128, longitude: -74.006, displayName: 'New York' },
  nyc: { latitude: 40.7128, longitude: -74.006, displayName: 'New York' },
  'los angeles': { latitude: 34.0522, longitude: -118.2437, displayName: 'Los Angeles' },
  la: { latitude: 34.0522, longitude: -118.2437, displayName: 'Los Angeles' },
  chicago: { latitude: 41.8781, longitude: -87.6298, displayName: 'Chicago' },
  miami: { latitude: 25.7617, longitude: -80.1918, displayName: 'Miami' },
  houston: { latitude: 29.7604, longitude: -95.3698, displayName: 'Houston' },
  'san francisco': { latitude: 37.7749, longitude: -122.4194, displayName: 'San Francisco' },
  sf: { latitude: 37.7749, longitude: -122.4194, displayName: 'San Francisco' },
  seattle: { latitude: 47.6062, longitude: -122.3321, displayName: 'Seattle' },
  boston: { latitude: 42.3601, longitude: -71.0589, displayName: 'Boston' },

  toronto: { latitude: 43.6532, longitude: -79.3832, displayName: 'Toronto' },
  'mexico city': { latitude: 19.4326, longitude: -99.1332, displayName: 'Mexico City' },
  'sao paulo': { latitude: -23.5505, longitude: -46.6333, displayName: 'São Paulo' },
  sydney: { latitude: -33.8688, longitude: 151.2093, displayName: 'Sydney' },
};

export function lookupCity(name: string): CityCoords | null {
  return RAW[name.toLowerCase().trim()] ?? null;
}

export function knownCities(): readonly string[] {
  return Object.keys(RAW);
}
