export const SIDES = ['l', 'r', 'b', 't', 'g', 'f'];
export const OPPOSITE = { l: 'r', r: 'l', b: 't', t: 'b', g: 'f', f: 'g' };
export const SIDE_AXIS = { l: 'x', r: 'x', b: 'y', t: 'y', g: 'z', f: 'z' };
export const SIDE_NB = { l: 'x1', r: 'x2', b: 'y1', t: 'y2', g: 'z1', f: 'z2' };
export const AXIS_SIDES = { x: ['l', 'r'], y: ['b', 't'], z: ['g', 'f'] };
export const GROUP_THICK_AXIS = { 0: 'z', 1: 'y', 2: 'x' };
export const SIDE_LABEL = { l: 'Лево', r: 'Право', b: 'Низ', t: 'Верх', g: 'Зад', f: 'Перед' };

export const EPS = 0.01;

export const snap = (v) => Math.round(v * 100);
export const gt = (a, b) => snap(a) > snap(b);
export const lt = (a, b) => snap(a) < snap(b);
export const eq = (a, b) => snap(a) === snap(b);

export function handleSize(row, horizontal) {
  const length = row.h || row.minH || 64;
  const width = row.w || row.minW || 20;
  return { sx: horizontal ? length : width, sy: horizontal ? width : length, sz: Math.max(row.t || row.minT || 5, 5) };
}

export function edgeSides(group) {
  return SIDES.filter((s) => SIDE_AXIS[s] !== GROUP_THICK_AXIS[group]);
}

export function sideMap(value) {
  const fn = typeof value === 'function' ? value : () => value;
  return Object.fromEntries(SIDES.map((s) => [s, fn(s)]));
}

export class Box {
  constructor(l = 0, r = 0, b = 0, t = 0, g = 0, f = 0) {
    Object.assign(this, { l, r, b, t, g, f });
  }

  static fromCenter(cx, cy, cz, sx, sy, sz) {
    return new Box(cx - sx / 2, cx + sx / 2, cy - sy / 2, cy + sy / 2, cz - sz / 2, cz + sz / 2);
  }

  clone() { return new Box(this.l, this.r, this.b, this.t, this.g, this.f); }

  get sx() { return this.r - this.l; }
  get sy() { return this.t - this.b; }
  get sz() { return this.f - this.g; }
  get cx() { return (this.l + this.r) / 2; }
  get cy() { return (this.b + this.t) / 2; }
  get cz() { return (this.g + this.f) / 2; }

  size(axis) { return axis === 'x' ? this.sx : axis === 'y' ? this.sy : this.sz; }
  center(axis) { return axis === 'x' ? this.cx : axis === 'y' ? this.cy : this.cz; }

  setSize(axis, value, anchor = 'center') {
    const [lo, hi] = AXIS_SIDES[axis];
    if (anchor === lo) this[hi] = this[lo] + value;
    else if (anchor === hi) this[lo] = this[hi] - value;
    else { const c = this.center(axis); this[lo] = c - value / 2; this[hi] = c + value / 2; }
    return this;
  }

  moveSide(side, value) {
    const delta = value - this[side];
    const [lo, hi] = AXIS_SIDES[SIDE_AXIS[side]];
    this[lo] += delta; this[hi] += delta;
    return this;
  }

  moveCenter(axis, value) {
    const delta = value - this.center(axis);
    const [lo, hi] = AXIS_SIDES[axis];
    this[lo] += delta; this[hi] += delta;
    return this;
  }

  overlaps(other, axis) {
    const [lo, hi] = AXIS_SIDES[axis];
    return gt(other[hi], this[lo]) && lt(other[lo], this[hi]);
  }
}
