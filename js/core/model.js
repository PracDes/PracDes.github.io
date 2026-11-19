import { Box, sideMap, SIDES, GROUP_THICK_AXIS } from './geom.js';

export const KIND = {
  WALL: -12, FLOOR_WALL: -22,
  POL: 6, BOK: 7, POLKA: 8, PEREG: 9, ZAD: 16, ROOM_ELEMENT: 17,
  BOX_NAKL: 14, BOX_VKL: 15, DOOR_ZONE: 34, DOOR_SET: 1034, GUIDE: 40,
  HANDLE: 1010, HINGE_IN: 1018, HINGE_ON: 1019, HINGE_HALF: 1020, HARDWARE: 2222,
};

export const PANEL_KINDS = new Set([KIND.POL, KIND.BOK, KIND.POLKA, KIND.PEREG, KIND.ZAD]);
export const isPanel = (part) => PANEL_KINDS.has(part.kind);
export const isWall = (part) => part.kind < 0;
export const isFullyLocked = (part) => part.stenDver === -9 && !part.data.drawer && !part.parent;
export const canLockPart = (part) => isPanel(part) && !part.parent && !part.casper && [0, -1, -9].includes(part.stenDver);

export function boxWalls({ W, H, G }, allocateId) {
  const mk = (side, kind, group, box) => new Part({ id: allocateId(side), kind, group, role: 'wall-' + side, box, name: 'Граница изделия' });
  return {
    g: mk('g', -12, 0, new Box(0, W, 0, H, 0, 0)),
    l: mk('l', -12, 2, new Box(0, 0, 0, H, 0, G)),
    r: mk('r', -12, 2, new Box(W, W, 0, H, 0, G)),
    t: mk('t', -12, 1, new Box(0, W, H, H, 0, G)),
    b: mk('b', -22, 1, new Box(0, W, 0, 0, 0, G)),
    f: mk('f', -12, 0, new Box(0, W, 0, H, G, G)),
  };
}

export class Part {
  constructor(init = {}) {
    Object.assign(this, {
      id: 0, kind: 0, group: 0, name: '', title: '', tag: '', kod: 0, color: '',
      box: new Box(),
      mount: sideMap(false), krep: sideMap(0), grab: sideMap(-1), ftex: sideMap(0),
      edge: sideMap(0), edgeForce: sideMap(false), edgeKod: sideMap(0), fixKr: sideMap(0), kr: sideMap(0),
      min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 },
      parent: 0, children: [], nb: { x1: 0, x2: 0, y1: 0, y2: 0, z1: 0, z2: 0 },
      casper: false, hidden: false, stenDver: -1, qty: 1, role: '', excluded: false, data: {},
    }, init);
    if (!(this.box instanceof Box)) this.box = Object.assign(new Box(), this.box);
  }

  get thickAxis() { return GROUP_THICK_AXIS[this.group] ?? 'z'; }
  get thickness() { return this.box.size(this.thickAxis); }
  get catalogThickness() { return this.max[this.thickAxis]; }

  toJSON() {
    const { box, ...rest } = this;
    return { ...rest, box: { ...box } };
  }
}

export class Product {
  constructor(init = {}) {
    Object.assign(this, {
      id: 0, num: 1, title: 'Корпусное изделие', tip: 'Корпусное изделие', podTip: 'Из ДСП',
      W: 0, H: 0, G: 0, x: 0, y: 0, z: 0, angle: 0, count: 1,
      krepKor: '', krepNap: '', krepCr1: '', krepCr2: '', zag1: 0, zag2: 0,
      nachColor: '', firma: '', kromkaNap: 0, krColor: '', useKromE: true, podvesnoi: false,
      roles: {}, form: null, through: false,
    }, init);
    this.parts = new Map();
    this.walls = {};
  }

  get(id) {
    return this.parts.get(id) ?? Object.values(this.walls).find((w) => w.id === id) ?? null;
  }

  role(name) { return this.roles[name] ? this.get(this.roles[name]) : null; }
  isCorpus(part) { return ['PL', 'PR', 'PB', 'PT', 'PG'].some((r) => this.roles[r] === part.id); }

  *realParts() { for (const p of this.parts.values()) if (p.kind >= 6) yield p; }

  toJSON() {
    const { parts, walls, ...rest } = this;
    return { ...rest, parts: [...parts.values()], walls };
  }
}

export class Project {
  constructor() {
    this.room = null;
    this.products = [];
    this.nextId = 1;
    this.info = { number: '', note: '' };
  }

  newId() { return this.nextId++; }

  createWalls(product) {
    product.walls = boxWalls(product, () => this.newId());
  }

  addProduct(init) {
    const product = new Product({ ...init, id: this.newId(), num: this.products.length + 1 });
    this.createWalls(product);
    this.products.push(product);
    return product;
  }

  copyProduct(source) {
    const { parts, walls, ...init } = structuredClone(source.toJSON());
    const product = this.addProduct({ ...init, through: true });
    const ids = new Map(SIDES.map((side) => [walls[side].id, product.walls[side].id]));
    for (const part of parts) ids.set(part.id, this.newId());
    const remap = (id) => ids.get(id) ?? id;
    const remapEntries = (entries) => Object.fromEntries(Object.entries(entries).map(([key, id]) => [key, remap(id)]));
    const copyPart = (part) => {
      const { data } = part;
      if (data.drawer && data.cuts) data.cuts = data.cuts.map(remap);
      if (data.door && data.cuts) data.cuts = data.cuts.map((cut) => ({ ...cut, id: remap(cut.id), stenDver: remap(cut.stenDver) }));
      if (data.yglybBy) data.yglybBy = data.yglybBy.map(remap);
      return new Part({ ...part, id: remap(part.id), parent: remap(part.parent), children: part.children.map(remap),
        nb: remapEntries(part.nb), stenDver: remap(part.stenDver) });
    };
    product.roles = remapEntries(product.roles);
    for (const side of SIDES) product.walls[side] = copyPart(walls[side]);
    for (const part of parts) product.parts.set(remap(part.id), copyPart(part));
    return product;
  }

  removeProduct(product) {
    this.products = this.products.filter((p) => p !== product);
    this.products.forEach((p, i) => { p.num = i + 1; });
  }

  addPart(product, init) {
    const part = new Part({ ...init, id: this.newId() });
    product.parts.set(part.id, part);
    if (part.parent) product.get(part.parent)?.children.push(part.id);
    return part;
  }

  removePart(product, part) {
    for (const childId of [...part.children]) {
      const child = product.get(childId);
      if (child) this.removePart(product, child);
    }
    product.parts.delete(part.id);
    const parent = part.parent && product.get(part.parent);
    if (parent) parent.children = parent.children.filter((id) => id !== part.id);
    for (const [role, id] of Object.entries(product.roles)) if (id === part.id) delete product.roles[role];
  }

  toJSON() {
    return { version: 1, room: this.room, info: this.info, nextId: this.nextId, products: this.products };
  }

  static fromJSON(data) {
    const project = new Project();
    project.room = data.room ?? null;
    project.info = data.info ?? project.info;
    project.nextId = data.nextId ?? 1;
    for (const pd of data.products ?? []) {
      const { parts, walls, ...rest } = pd;
      const product = new Product(rest);
      for (const s of SIDES) product.walls[s] = new Part(walls[s]);
      for (const p of parts) product.parts.set(p.id, new Part(p));
      project.products.push(product);
    }
    return project;
  }
}
