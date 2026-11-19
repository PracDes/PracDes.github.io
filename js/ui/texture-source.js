import { texturePath, textureUrl } from '../core/textures.js';

let offlineTextures;

export async function loadOfflineTextures() {
  if (location.protocol !== 'file:') return;
  await new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'data/offline-textures.js';
    script.onload = script.onerror = resolve;
    document.head.append(script);
  });
  offlineTextures = globalThis.npOfflineTextures ?? {};
  delete globalThis.npOfflineTextures;
}

export function materialTextureUrl(value) {
  if (!offlineTextures) return textureUrl(value);
  return offlineTextures[texturePath(value)] ?? null;
}
