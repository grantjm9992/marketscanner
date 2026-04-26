import { describe, it, expect, vi } from 'vitest';
import { GeocodeCache } from '../../../../src/forecasts/weather/geocode.js';
import { createLogger } from '../../../../src/logging/logger.js';

const logger = createLogger({ level: 'silent' });

function makeResponse(results: Array<{ name: string; latitude: number; longitude: number }>): Response {
  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GeocodeCache', () => {
  it('returns hardcoded city without any fetch', () => {
    const fetcher = vi.fn();
    const cache = new GeocodeCache({ logger, fetcher });
    const coords = cache.get('Seoul');
    expect(coords).not.toBeNull();
    expect(coords?.displayName).toBe('Seoul');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns null for unknown city before prefetch', () => {
    const cache = new GeocodeCache({ logger });
    expect(cache.get('Atlantis')).toBeNull();
    expect(cache.isKnownMissing('Atlantis')).toBe(false);
    expect(cache.isPending('Atlantis')).toBe(false);
  });

  it('resolves an unknown city after prefetch completes', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse([{ name: 'Atlantis', latitude: 0, longitude: 0 }]),
    );
    const cache = new GeocodeCache({ logger, fetcher });
    cache.prefetch('Atlantis');
    expect(cache.isPending('Atlantis')).toBe(true);
    // Let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.isPending('Atlantis')).toBe(false);
    expect(cache.isKnownMissing('Atlantis')).toBe(false);
    expect(cache.get('Atlantis')).not.toBeNull();
    expect(cache.get('Atlantis')?.displayName).toBe('Atlantis');
  });

  it('marks city as known-missing when API returns empty results', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeResponse([]));
    const cache = new GeocodeCache({ logger, fetcher });
    cache.prefetch('Faketown');
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.isKnownMissing('Faketown')).toBe(true);
    expect(cache.get('Faketown')).toBeNull();
  });

  it('prefetch is a no-op for already-pending cities (no duplicate requests)', () => {
    const fetcher = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const cache = new GeocodeCache({ logger, fetcher });
    cache.prefetch('Somewhere');
    cache.prefetch('Somewhere');
    cache.prefetch('Somewhere');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('prefetch is a no-op for hardcoded cities', () => {
    const fetcher = vi.fn();
    const cache = new GeocodeCache({ logger, fetcher });
    cache.prefetch('Tokyo');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is case-insensitive', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse([{ name: 'Somewhere', latitude: 10, longitude: 20 }]),
    );
    const cache = new GeocodeCache({ logger, fetcher });
    cache.prefetch('somewhere');
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.get('SOMEWHERE')).not.toBeNull();
    expect(cache.get('Somewhere')).not.toBeNull();
  });
});
