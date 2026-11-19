export function texturePath(value) {
  if (typeof value !== 'string' || !/\.(?:jpe?g|png|bmp)$/i.test(value)) return null;
  const segments = value.replaceAll('\\', '/').split('/');
  if (segments.some((s) => !s || s === '.' || s === '..' || s.includes(':'))) return null;
  return segments.join('/').toLowerCase();
}

export function textureUrl(value) {
  const path = texturePath(value);
  return path ? 'textures/' + path.split('/').map(encodeURIComponent).join('/') : null;
}
export const ROOM_TEXTURES = {
  floor: 'b_H1348_ST3.jpg', walls: 'Wall.jpg',
  Окно: 'Окно.jpg', Проем: 'Проем.png', Розетка: 'Розетка.jpg', 'Заготовки креплений': 'черный.jpg',
};
