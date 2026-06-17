const MEDIA_CACHE_NAME = 'tweetweb-media-v1';

function canUseCacheStorage(): boolean {
  return typeof window !== 'undefined' && 'caches' in window;
}

function cacheableUrl(url: string): string | null {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null;
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return null;
  }
}

export async function getCachedMediaObjectUrl(url: string): Promise<string | null> {
  const href = cacheableUrl(url);
  if (!href || !canUseCacheStorage()) return null;

  try {
    const cache = await caches.open(MEDIA_CACHE_NAME);
    const response = await cache.match(href);
    if (!response || !response.ok || response.type === 'opaque') return null;

    const blob = await response.blob();
    if (blob.size <= 0) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

export async function cacheMediaUrl(url: string): Promise<void> {
  const href = cacheableUrl(url);
  if (!href || !canUseCacheStorage()) return;

  try {
    const cache = await caches.open(MEDIA_CACHE_NAME);
    if (await cache.match(href)) return;

    const response = await fetch(href, { cache: 'force-cache' });
    if (!response.ok || response.type === 'opaque') return;
    await cache.put(href, response.clone());
  } catch {
    // Cross-origin media without CORS can still render in <img>/<video>, but
    // cannot be read into Cache Storage. In that case the browser HTTP cache
    // remains the fallback.
  }
}

export function releaseMediaObjectUrl(url: string | null | undefined): void {
  if (url?.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}
