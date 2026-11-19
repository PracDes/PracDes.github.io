import * as THREE from '../../vendor/three.module.min.js';
import { OrbitControls } from '../../vendor/OrbitControls.js';
import { OPENING_SUPPORTS, opening } from '../core/opora.js';
import { placementNeighbors, productCursorWheelDelta } from '../core/build.js';
import { canMove, DRAG_STEP } from '../core/move.js';
import { KIND } from '../core/model.js';
import { materialTextureUrl } from './texture-source.js';
import { ROOM_TEXTURES } from '../core/textures.js';
import { normalizeAngle, productCenter, productPositionError } from '../core/product.js';
import { AXIS_SIDES, SIDES, SIDE_AXIS, SIDE_NB } from '../core/geom.js';
import { isRoomLamp, planRoomElement, roomAxisFixed, roomCursorOverlaps, roomElementBox, roomPlacementContext } from '../core/room.js';
import { confirmDialog, h } from './dialogs.js';

const MM = 0.001;
const DRAG_START = 4;
const HARDWARE_COLOR = 0xb9bcc2;
const PART_OUTLINE_STORAGE_KEY = 'np-web-part-outline';
const PART_OUTLINE_MODES = [
  { id: 'black', color: 0x000000, label: 'Чёрная' },
  { id: 'red', color: 0xff0000, label: 'Красная' },
  { id: 'green', color: 0x00ff00, label: 'Зелёная' },
  { id: 'white', color: 0xffffff, label: 'Белая' },
  { id: 'off', color: null, label: 'Выключена' },
];
const SELECT_FILL = 0x92d050;
const FRAME_COLOR = 0x92d050;
const BOUNDARY_COLORS = [0x000000, 0xff0000, 0x00ff00, 0xffffff];
const FACADE_BOUNDARY_COLOR = 0xe64073;
const MAKET_COLOR = 0x334073;
const MAKET_COLLISION = 0xe64073;
const TOOL_HINT = 'ЛКМ — установить · Колесо или Shift+мышь — глубина · Esc — отменить';
const TOOL_OPTIONS_HINT = 'ПКМ — параметры установки';
const CURSOR_MM_PER_PIXEL = 10;
const LEFT_BUTTON = 1;
const RIGHT_BUTTON = 2;
const MIDDLE_BUTTON = 4;
const BOTH_BUTTONS = LEFT_BUTTON | RIGHT_BUTTON;
const DOOR_KINDS = new Set([KIND.DOOR_ZONE, KIND.DOOR_SET]);
const UP = new THREE.Vector3(0, 1, 0);
const AXIS_VECTOR = { x: new THREE.Vector3(1, 0, 0), y: UP, z: new THREE.Vector3(0, 0, 1) };
const yaw = (product) => -THREE.MathUtils.degToRad(normalizeAngle(product.angle));

function loadPartOutlineIndex() {
  try {
    const id = localStorage.getItem(PART_OUTLINE_STORAGE_KEY);
    return Math.max(0, PART_OUTLINE_MODES.findIndex((mode) => mode.id === id));
  } catch {
    return 0;
  }
}

function setProductTransform(group, product) {
  const center = productCenter(product);
  group.rotation.y = yaw(product);
  const shift = new THREE.Vector3(product.W / 2, 0, product.G / 2).applyAxisAngle(UP, group.rotation.y);
  group.position.set((center.x - shift.x) * MM, product.y * MM, (center.z - shift.z) * MM);
}

function productBoundary(box, color) {
  const geometry = new THREE.EdgesGeometry(box);
  const positions = geometry.getAttribute('position');
  const colors = new THREE.Float32BufferAttribute(new Float32Array(positions.count * 3), 3);
  const facade = new THREE.Color(FACADE_BOUNDARY_COLOR);
  const other = new THREE.Color(color);
  for (let i = 0; i < positions.count; i += 2) {
    const startZ = positions.getZ(i);
    const endZ = positions.getZ(i + 1);
    const { r, g, b } = startZ > 0 && endZ > 0 ? facade : other;
    if (startZ > 0) positions.setZ(i, startZ + MM);
    if (endZ > 0) positions.setZ(i + 1, endZ + MM);
    colors.setXYZ(i, r, g, b);
    colors.setXYZ(i + 1, r, g, b);
  }
  geometry.setAttribute('color', colors);
  const frame = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true }));
  frame.renderOrder = 2;
  return frame;
}

function mapBoardTexture(geometry, horizontal) {
  const { width, height, depth } = geometry.parameters;
  const { position, uv, normal } = geometry.attributes;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i) + width / 2;
    const y = position.getY(i) + height / 2;
    const z = position.getZ(i) + depth / 2;
    const onHorizontal = horizontal ?? (Math.abs(normal.getY(i)) > 0.5);
    uv.setXY(i, (z + (onHorizontal ? y : x)) * 2.68, onHorizontal ? x : y);
  }
}

function applyTexture(material, texture) {
  material.map = texture;
  material.color.set(material.userData.textureTint ?? 0xffffff);
  material.needsUpdate = true;
}

function hashColor(name) {
  const n = (name ?? '').toLowerCase();
  if (/бел|white|снег|альпийск/.test(n)) return new THREE.Color(0xf2f0ea);
  if (/черн|чёрн|black|антрацит|графит/.test(n)) return new THREE.Color(0x3a3a3c);
  if (/венге|wenge/.test(n)) return new THREE.Color(0x4a3328);
  if (/сер|grey|gray|бетон|алюмин/.test(n)) return new THREE.Color(0xa9a9a6);
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((22 + (h % 24)) / 360, (28 + ((h >> 5) % 28)) / 100, (48 + ((h >> 11) % 28)) / 100);
}

export class Viewport {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.showDoors = true;
    this.showWalls = true;
    this.boundaryColor = 0;
    this.partOutlineIndex = loadPartOutlineIndex();
    this.textures = new Map();
    this.partHits = [];
    this.productHits = [];
    this.roomElementMeshes = new Map();
    this.roomElementHits = [];
    this.productGroups = new Map();
    this.creationSupports = new Set();
    this.textureLoader = new THREE.TextureLoader();
    this.meshes = new Map();
    this.selectedMaterial = new THREE.MeshBasicMaterial({
      color: SELECT_FILL, toneMapped: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    const { color } = this.partOutlineMode;
    this.partOutlineMaterial = new THREE.LineBasicMaterial({
      color: color ?? PART_OUTLINE_MODES[0].color, visible: color !== null, linewidth: 1, depthWrite: false, toneMapped: false,
    });
    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.creationRaycaster = new THREE.Raycaster();
    this.drag = null;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x505050);
    host.appendChild(this.renderer.domElement);
    this.positionLabels = new Map(SIDES.map((side) => [side, h('span')]));
    this.positionLine = h('div', { id: 'product-distance-line', hidden: true });
    this.positionLayer = h('div', { id: 'product-distance-labels', ariaHidden: 'true', hidden: true },
      this.positionLine, [...this.positionLabels.values()]);
    host.append(this.positionLayer);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: null };
    this.controls.touches.ONE = null;
    this.controls.addEventListener('change', () => this.render());

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(2, 5, 6);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-4, 2, 3);
    this.scene.add(fill);

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.roomLight = new THREE.PointLight(0xffefd0, 5, 5);
    this.marker = this.makeMarker();
    this.scene.add(this.marker);
    this.maket = this.makeMaket();
    this.scene.add(this.maket);

    const el = this.renderer.domElement;
    el.tabIndex = 0;
    el.setAttribute('aria-label', '3D-вид изделия');
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', (e) => this.onUp(e));
    el.addEventListener('lostpointercapture', (e) => this.onUp(e));
    el.addEventListener('pointerleave', () => this.endRoomShiftDrag());
    window.addEventListener('keyup', (e) => { if (e.key === 'Shift') this.endRoomShiftDrag(); });
    window.addEventListener('blur', () => this.endRoomShiftDrag());
    document.addEventListener('pointerdown', () => this.endRoomShiftDrag(), true);
    el.addEventListener('wheel', (e) => {
      const target = this.creationTarget;
      if (!target || !this.creationCursor || !e.deltaY) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const delta = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 120 : 1);
      const cursor = this.creationCursor;
      cursor.z += app.editingRoom ? delta : productCursorWheelDelta(target, cursor, delta);
      this.clampCreationCursor(target, 10);
      this.showCreationMarker();
      this.render();
    }, { capture: true, passive: false });
    el.addEventListener('dblclick', (e) => {
      if (app.mode !== 'room' || app.placement) return;
      if (app.editingRoom) {
        if (!app.tool) app.toggleRoomLamp(app.roomSelected);
        return;
      }
      const target = this.contextTarget(e);
      if (target) app.activate(target.productId);
    });
    new ResizeObserver(() => this.resize()).observe(host);

    app.addEventListener('change', () => this.sync());
    app.addEventListener('room-element-position', () => {
      for (const element of app.project.room.elements) this.positionRoomElement(element);
      this.render();
    });
    app.addEventListener('product-position', ({ detail }) => {
      const group = this.productGroups.get(detail.id);
      if (!group) return;
      setProductTransform(group, detail);
      if (group.userData.activeMarker) this.positionActiveProductMarker(group.userData.activeMarker, detail, app.project.room);
      this.render();
    });
    app.addEventListener('mode', () => { this.endRoomShiftDrag(); this.sync(); });
    app.addEventListener('select', () => { this.endRoomShiftDrag(); this.highlight(); });
    app.addEventListener('tool', () => {
      this.endRoomShiftDrag();
      const target = this.creationTarget;
      this.creationPointer = null;
      this.creationCursor = target ? { x: target.W / 2, y: target.H / 2, z: app.tool.depth?.(target) ?? target.G / 2 } : null;
      if (target) {
        el.focus({ preventScroll: true });
        this.clampCreationCursor(target);
      }
      this.showCreationMarker();
      this.render();
    });
    app.addEventListener('placement', () => {
      this.marker.visible = false;
      this.sync();
      this.showPlacement();
      this.render();
    });
    app.addEventListener('placement-position', () => { this.showPlacement(); this.render(); });
    app.addEventListener('position-measurements', ({ detail }) => {
      this.positionMeasurements = detail;
      this.positionField = detail?.focused;
      this.drawPositionMeasurements();
    });
    app.addEventListener('position-field', ({ detail }) => {
      this.positionField = detail;
      this.drawPositionMeasurements();
    });
    app.addEventListener('position-center', () => this.view('center'));
    app.addEventListener('hint', (e) => this.setHint(e.detail));
    this.resize();
    this.sync();
  }

  get creationTarget() {
    const { app } = this;
    if (!app.tool || app.placement) return null;
    if (app.editingRoom && app.tool.room) return app.project.room;
    return app.mode === 'product' ? app.product : null;
  }

  makeMarker() {
    const g = new THREE.Group();
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const frame = new THREE.LineSegments(new THREE.EdgesGeometry(unit), new THREE.LineBasicMaterial({ color: FRAME_COLOR }));
    const ghost = new THREE.Mesh(unit, new THREE.MeshBasicMaterial({ color: MAKET_COLOR, transparent: true, opacity: 0.5, depthWrite: false }));
    const ghostFrame = new THREE.LineSegments(new THREE.EdgesGeometry(unit), new THREE.LineBasicMaterial({ color: 0xffe14a }));
    const axisGeometry = new THREE.BufferGeometry();
    const colors = [[0.5, 0, 0], [1, 0, 0], [0, 0.5, 0], [0, 1, 0], [0, 0, 0.5], [0, 0, 1]];
    const length = this.camera.far - this.camera.near;
    axisGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, -length, 0, 0, 0, 0, 0, length, 0, 0,
      0, 0, 0, 0, -length, 0, 0, 0, 0, 0, length, 0,
      0, 0, 0, 0, 0, -length, 0, 0, 0, 0, 0, length,
    ], 3));
    axisGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors.flatMap((color) => [...color, ...color]), 3));
    const cross = new THREE.LineSegments(axisGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: true, depthWrite: true }));
    cross.frustumCulled = false;
    cross.renderOrder = 2;
    g.add(frame, ghost, ghostFrame, cross);
    g.userData = { frame, ghost, ghostFrame, cross };
    g.visible = false;
    return g;
  }

  makeMaket() {
    const group = new THREE.Group();
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const surface = (color) => new THREE.Mesh(unit, new THREE.MeshLambertMaterial({
      color, transparent: true, opacity: 0.5, depthWrite: false,
    }));
    const body = surface(MAKET_COLOR);
    const front = surface(FRAME_COLOR);
    group.add(body, front);
    group.userData = { body, front };
    group.visible = false;
    return group;
  }

  makeActiveProductMarker(product, room) {
    const group = new THREE.Group();
    group.name = 'Маркер активного изделия';
    group.position.set(product.W * MM / 2, product.H * MM, product.G * MM / 2);
    const material = new THREE.MeshLambertMaterial({ color: MAKET_COLOR });
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.2), material);
    base.position.y = 0.01;
    const stem = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1, 0.03), material);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 32, 16), material);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.2, 32), material);
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = 0.05;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.1, 32), material);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = 0.2;
    head.add(shaft, tip);
    group.add(base, stem, head);
    group.userData = { head, stem };
    this.positionActiveProductMarker(group, product, room);
    return group;
  }

  positionActiveProductMarker(group, product, room) {
    const { head, stem } = group.userData;
    head.position.y = (room.H - product.y - product.H) * MM + 0.175;
    stem.scale.y = Math.max(0, head.position.y - 0.105);
    stem.position.y = stem.scale.y / 2 + 0.02;
  }

  cycleBoundaryColor() {
    this.boundaryColor = (this.boundaryColor + 1) % BOUNDARY_COLORS.length;
    this.sync();
  }

  get partOutlineMode() { return PART_OUTLINE_MODES[this.partOutlineIndex]; }

  cyclePartOutline() {
    this.partOutlineIndex = (this.partOutlineIndex + 1) % PART_OUTLINE_MODES.length;
    const { id, color } = this.partOutlineMode;
    this.partOutlineMaterial.visible = color !== null;
    if (color !== null) this.partOutlineMaterial.color.setHex(color);
    try { localStorage.setItem(PART_OUTLINE_STORAGE_KEY, id); } catch {}
    this.render();
  }

  setHint(text) { this.host.querySelector('#hint').textContent = text; }

  resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.viewSize = { w, h };
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
    this.drawPositionMeasurements();
  }

  drawPositionMeasurements() {
    const { app, positionMeasurements, positionField } = this;
    const inRoom = positionMeasurements && app.mode === 'room';
    const labels = inRoom && (app.placement || app.moveMode);
    const line = inRoom && positionField && Number.isFinite(positionField.gap);
    this.positionLayer.hidden = !labels && !line;
    if (this.positionLayer.hidden) return;
    const { box, gaps } = positionMeasurements;
    const { w, h } = this.viewSize;
    const center = new THREE.Vector3(box.cx, box.cy, box.cz);
    const project = (point) => {
      point.multiplyScalar(MM).project(this.camera);
      if (point.z < -1 || point.z > 1) return null;
      return point.set((point.x + 1) * w / 2, (1 - point.y) * h / 2, 0);
    };
    for (const [side, label] of this.positionLabels) {
      label.hidden = !labels;
      if (label.hidden) continue;
      const axis = SIDE_AXIS[side];
      const sign = side === AXIS_SIDES[axis][0] ? -1 : 1;
      const point = center.clone();
      point[axis] = box[side];
      if (axis === 'x' && !app.placement) point.x += sign * 300;
      if (axis === 'z') {
        point.y -= sign * 100;
        point.z += sign * (app.placement ? 200 : 300);
      }
      const screen = project(point);
      label.hidden = !screen;
      if (screen) {
        const text = SIDE_NB[side].toUpperCase() + ': ' + gaps[side];
        if (label.textContent !== text) label.textContent = text;
        label.style.transform = `translate(${screen.x}px,${screen.y}px) translate(-50%,-50%)`;
      }
    }
    this.positionLine.hidden = true;
    if (!line) return;
    const { side, gap } = positionField;
    const axis = SIDE_AXIS[side];
    const sign = side === AXIS_SIDES[axis][0] ? -1 : 1;
    const start = center.clone();
    start[axis] = box[side];
    const end = start.clone();
    end[axis] += sign * gap;
    const a = project(start);
    const b = project(end);
    if (!a || !b) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    this.positionLine.style.width = Math.hypot(dx, dy) + 'px';
    this.positionLine.style.transform = `translate(${a.x}px,${a.y - 2}px) rotate(${Math.atan2(dy, dx)}rad)`;
    this.positionLine.hidden = false;
  }

  materialFor(part, row) {
    if (part.kind >= 1000 || part.kind === KIND.GUIDE) return new THREE.MeshLambertMaterial({ color: HARDWARE_COLOR });
    const mat = new THREE.MeshLambertMaterial({ color: hashColor(row?.color ?? part.color) });
    return this.withTexture(mat, row?.tex);
  }

  withTexture(mat, file, tint) {
    const url = materialTextureUrl(file);
    if (!url) return mat;
    mat.userData.textureUrl = url;
    mat.userData.textureTint = tint;
    const texture = this.textures.get(url);
    if (texture) {
      applyTexture(mat, texture);
    } else if (texture === undefined) {
      this.textures.set(url, null);
      this.textureLoader.load(url, (loaded) => {
        loaded.colorSpace = THREE.SRGBColorSpace;
        loaded.wrapS = loaded.wrapT = THREE.MirroredRepeatWrapping;
        this.textures.set(url, loaded);
        this.root.traverse((object) => {
          const material = object.userData.baseMaterial ?? object.material;
          for (const value of Array.isArray(material) ? material : [material]) {
            if (value?.userData.textureUrl === url) applyTexture(value, loaded);
          }
        });
        this.render();
      }, undefined, () => {});
    }
    return mat;
  }

  addRoomElement(element) {
    const boxMesh = (material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
      mesh.userData = { roomId: element.id, baseMaterial: material };
      const outline = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), this.partOutlineMaterial);
      outline.renderOrder = 1;
      mesh.add(outline);
      this.root.add(mesh);
      this.roomElementHits.push(mesh);
      return mesh;
    };
    const lamp = isRoomLamp(element);
    const lit = this.app.project.room.activeLamp === element.id;
    const tint = !element.tag ? element.wallColor : null;
    const material = element.kod ? this.materialFor(element, this.app.db.get(element.kod)) : lamp
      ? new THREE.MeshLambertMaterial({ color: 0xf3eee2, emissive: lit ? 0xffdd97 : 0 })
      : this.withTexture(new THREE.MeshLambertMaterial({ color: tint ?? 0xdad9bd }), ROOM_TEXTURES[element.tag] ?? ROOM_TEXTURES.walls, tint);
    const mesh = boxMesh(material);
    this.roomElementMeshes.set(element.id, mesh);
    if (lamp && lit) this.root.add(this.roomLight);
    this.positionRoomElement(element);
  }

  positionRoomElement(element) {
    const { room } = this.app.project;
    const mesh = this.roomElementMeshes.get(element?.id);
    if (!mesh) return;
    const box = roomElementBox(room, element);
    this.placeBox(mesh, box);
    if (room.activeLamp === element.id) this.roomLight.position.set(box.cx * MM, (box.b - 5) * MM, box.cz * MM);
  }

  sync() {
    const { app } = this;
    const { project } = app;
    this.root.traverse((object) => {
      const material = object.userData.baseMaterial ?? object.material;
      object.geometry?.dispose();
      if (Array.isArray(material)) new Set(material).forEach((value) => value.dispose());
      else if (material !== this.partOutlineMaterial) material?.dispose();
    });
    this.root.clear();
    this.meshes.clear();
    this.partHits.length = 0;
    this.productHits.length = 0;
    this.roomElementHits.length = 0;
    this.roomElementMeshes.clear();
    this.productGroups.clear();
    const room = project.room;
    const activeProduct = app.mode === 'product' ? app.product : null;
    const editing = !!activeProduct && (app.sub === 'fill' || app.sub === 'doors');
    const showActiveMarker = room && project.products.length > 1 && app.mode === 'product'
      && (app.sub === 'overview' || app.sub === 'doors') && !app.placement;
    const showBoundary = editing && !app.placement;
    if (room) {
      const geo = new THREE.BoxGeometry(room.W * MM, room.H * MM, room.G * MM);
      mapBoardTexture(geo);
      const wall = this.withTexture(new THREE.MeshLambertMaterial({ color: room.wallColor ?? 0xb9b6ae, side: THREE.BackSide }),
        ROOM_TEXTURES.walls, room.wallColor);
      const floor = this.withTexture(new THREE.MeshLambertMaterial({ color: 0xa78f72, side: THREE.BackSide }), ROOM_TEXTURES.floor);
      const walls = new THREE.Mesh(geo, [wall, wall, wall, floor, wall, wall]);
      walls.position.set(room.W * MM / 2, room.H * MM / 2, room.G * MM / 2);
      walls.visible = this.showWalls;
      this.root.add(walls);
      for (const element of room.elements ?? []) this.addRoomElement(element);
    } else { this.marker.visible = false; }
    for (const product of project.products) {
      const group = new THREE.Group();
      setProductTransform(group, product);
      this.productGroups.set(product.id, group);
      group.userData.productId = product.id;
      const active = product.id === app.activeId;
      for (const part of product.parts.values()) {
        if (part.kind < 6 || part.hidden) continue;
        if (!this.showDoors && (DOOR_KINDS.has(part.kind) || part.data.door)) continue;
        const { box } = part;
        if (box.sx <= 0 || box.sy <= 0 || box.sz <= 0) continue;
        const geo = new THREE.BoxGeometry(box.sx * MM, box.sy * MM, box.sz * MM);
        const mat = this.materialFor(part, app.db.get(part.kod));
        if (mat.userData.textureUrl) mapBoardTexture(geo, part.group === 1);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(box.cx * MM, box.cy * MM, box.cz * MM);
        const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geo), this.partOutlineMaterial);
        outline.renderOrder = 1;
        mesh.userData = { partId: part.id, productId: product.id, baseMaterial: mat };
        mesh.add(outline);
        group.add(mesh);
        this.partHits.push(mesh);
        if (active) this.meshes.set(part.id, mesh);
      }
      if (app.mode === 'room' || (active && showBoundary)) {
        const box = new THREE.BoxGeometry(product.W * MM, product.H * MM, product.G * MM);
        const bounds = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
        bounds.position.set(product.W * MM / 2, product.H * MM / 2, product.G * MM / 2);
        bounds.userData.productId = product.id;
        if (showBoundary) bounds.add(productBoundary(box, BOUNDARY_COLORS[this.boundaryColor]));
        group.add(bounds);
        if (app.mode === 'room') this.productHits.push(bounds);
      }
      if (active && showActiveMarker) {
        const marker = this.makeActiveProductMarker(product, room);
        group.userData.activeMarker = marker;
        group.add(marker);
      }
      this.root.add(group);
    }
    this.syncView(room, activeProduct?.id ?? 0, editing);
    this.highlight();
  }

  syncView(room, productId, editing) {
    const roomSize = room ? `${room.W}x${room.H}x${room.G}` : '';
    const previous = this.viewContext;
    this.viewContext = { roomSize, productId, editing };
    if (!previous || roomSize !== previous.roomSize) this.view('iso');
    else if (editing && (!previous.editing || productId !== previous.productId)) this.view('front');
    else if (productId !== previous.productId) this.view('center');
  }

  highlight() {
    this.applyHighlights();
    this.render();
  }

  applyHighlights() {
    for (const [id, mesh] of this.meshes) {
      const selected = this.app.selectedIds.has(id) || this.creationSupports.has(id);
      mesh.material = selected ? this.selectedMaterial : mesh.userData.baseMaterial;
    }
    for (const mesh of this.roomElementHits) {
      const id = mesh.userData.roomId;
      const selected = this.app.editingRoom && (id === this.app.roomSelectedId || this.creationSupports.has(id));
      mesh.material = selected ? this.selectedMaterial : mesh.userData.baseMaterial;
    }
  }

  view(kind) {
    const room = this.app.project.room ?? { W: 3400, H: 2700, G: 2000 };
    const p = this.app.mode === 'product' ? this.app.product : null;
    const center = p ? productCenter(p) : { x: room.W / 2, y: room.H / 2, z: room.G / 2 };
    const target = new THREE.Vector3(center.x * MM, center.y * MM, center.z * MM);
    if (kind === 'center') {
      this.camera.position.add(target.clone().sub(this.controls.target));
    } else {
      const marker = this.productGroups.get(p?.id)?.userData.activeMarker;
      const markerSpan = marker ? 2 * (p.y + p.H + (marker.userData.head.position.y + 0.1) / MM - center.y) : 0;
      const span = p ? Math.max(p.W, p.H * 1.25, p.G, markerSpan) : Math.max(room.W, room.H * 1.3, room.G);
      const dist = (span * MM) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.25 + (p ? p.G : room.G) * MM / 2;
      const dir = kind === 'top' ? new THREE.Vector3(0, 1, 0.0001).normalize()
        : kind === 'front' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0.45, 0.28, 1).normalize();
      if (p) dir.applyAxisAngle(UP, yaw(p));
      this.camera.position.copy(target).addScaledVector(dir, dist);
    }
    this.controls.target.copy(target);
    this.controls.update();
    this.render();
  }

  setPointer(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  hit() {
    return this.raycaster.intersectObjects(this.partHits, false)[0] ?? null;
  }

  contextTarget(event) {
    this.setPointer(event);
    if (this.app.editingRoom) return this.roomHit()?.object.userData;
    const hit = this.hit() ?? this.raycaster.intersectObjects(this.productHits, false)[0];
    return hit?.object.userData;
  }

  roomHit() {
    const hit = this.raycaster.intersectObjects(this.roomElementHits, false)[0];
    const product = this.hit();
    return hit && (!product || hit.distance < product.distance) ? hit : null;
  }

  showPlacement() {
    const { project, placement } = this.app;
    this.maket.visible = !!placement;
    if (!placement) { this.setHint(''); return; }
    const error = productPositionError(project, placement);
    setProductTransform(this.maket, placement);
    const { body, front } = this.maket.userData;
    const { W, H, G } = placement;
    this.placeBox(body, { sx: W, sy: H, sz: G, cx: W / 2, cy: H / 2, cz: G / 2 });
    const inset = normalizeAngle(placement.angle) === 0 ? 20 : 25;
    this.placeBox(front, { sx: W - inset, sy: H - inset, sz: 5, cx: W / 2, cy: H / 2, cz: G });
    body.material.color.setHex(error ? MAKET_COLLISION : MAKET_COLOR);
    this.marker.visible = false;
    this.setHint(error || 'ЛКМ — передвинуть · Shift+ЛКМ — высота · ПКМ — повернуть камеру · Esc — отменить');
  }

  clampCreationCursor({ W, H, G }, margin = 3) {
    const clamp = (value, extent, inset) => {
      const limit = Math.min(extent / 2, inset);
      return THREE.MathUtils.clamp(value, limit, extent - limit);
    };
    const cursor = this.creationCursor;
    cursor.x = clamp(cursor.x, W, margin);
    cursor.y = clamp(cursor.y, H, margin);
    cursor.z = clamp(cursor.z, G, 1);
  }

  projectCursor(ray, localTransform) {
    if (localTransform) ray = ray.clone().applyMatrix4(localTransform);
    if (Math.abs(ray.direction.z) <= 0.2) return null;
    const plane = new THREE.Plane(AXIS_VECTOR.z, -this.creationCursor.z * MM);
    return ray.intersectPlane(plane, new THREE.Vector3());
  }

  rememberCreationPointer(event) {
    this.creationPointer = { x: event.clientX, y: event.clientY, normalized: this.pointer.clone() };
  }

  updateCreationCursor(event) {
    const target = this.creationTarget;
    const cursor = this.creationCursor;
    if (!target || !cursor) return;
    const previous = this.creationPointer;
    this.rememberCreationPointer(event);
    if (previous?.x === event.clientX && previous?.y === event.clientY) return;
    if (event.shiftKey) {
      if (previous) cursor.z -= (event.clientX - previous.x) * CURSOR_MM_PER_PIXEL;
    } else {
      const group = this.app.editingRoom ? null : this.productGroups.get(target.id);
      const local = group?.matrixWorld.clone().invert();
      const point = (!previous || group) && this.projectCursor(this.raycaster.ray, local);
      if (point && !previous) {
        cursor.x = point.x / MM;
        cursor.y = point.y / MM;
      } else if (previous) {
        if (point) this.creationRaycaster.setFromCamera(previous.normalized, this.camera);
        const start = point && this.projectCursor(this.creationRaycaster.ray, local);
        const z = local ? this.camera.position.clone().applyMatrix4(local).z - target.G * MM / 2 : this.camera.position.z - this.controls.target.z;
        cursor.x += start ? (point.x - start.x) / MM : (event.clientX - previous.x) * CURSOR_MM_PER_PIXEL * (z < 0 ? -1 : 1);
        cursor.y += start ? (point.y - start.y) / MM : (previous.y - event.clientY) * CURSOR_MM_PER_PIXEL;
      }
    }
    this.clampCreationCursor(target);
  }

  placeBox(mesh, box) {
    mesh.scale.set(Math.max(box.sx, 1) * MM, Math.max(box.sy, 1) * MM, Math.max(box.sz, 1) * MM);
    mesh.position.set(box.cx * MM, box.cy * MM, box.cz * MM);
  }

  showCross({ x, y, z }) {
    this.marker.userData.cross.position.set(x * MM, y * MM, z * MM);
  }

  showCreationMarker() {
    const target = this.creationTarget;
    const cursor = this.creationCursor;
    if (!target || !cursor) {
      this.creationSupports.clear();
      this.marker.visible = false;
      this.setHint('');
    } else if (this.app.editingRoom) this.showRoomMarker(target, cursor);
    else this.showMarker(target, cursor);
    this.applyHighlights();
  }

  showMarker(product, point) {
    const { frame, ghost, ghostFrame } = this.marker.userData;
    this.marker.visible = true;
    const supportIds = placementNeighbors(product, point);
    this.creationSupports = new Set(OPENING_SUPPORTS.map((side) => supportIds[side]));
    const o = opening(product, supportIds);
    setProductTransform(this.marker, product);
    this.showCross(point);
    frame.visible = o.w > 0 && o.h > 0 && o.d > 0;
    this.placeBox(frame, { sx: o.w, sy: o.h, sz: o.d, cx: (o.l + o.r) / 2, cy: (o.b + o.t) / 2, cz: (o.g + o.f) / 2 });
    const plan = this.app.tool.preview?.(product, { ...point, supportIds }) ?? null;
    if (plan) frame.visible = false;
    ghost.visible = ghostFrame.visible = !!plan?.valid;
    if (plan?.valid) { this.placeBox(ghost, plan.box); this.placeBox(ghostFrame, plan.box); }
    const size = plan?.valid ? plan.box : { sx: o.w, sy: o.h, sz: o.d };
    const dimensions = `Ширина: ${Math.round(size.sx)}   Высота: ${Math.round(size.sy)}   Глубина: ${Math.round(size.sz)} мм`;
    const hint = this.app.tool.options ? `${TOOL_HINT} · ${TOOL_OPTIONS_HINT}` : TOOL_HINT;
    this.setHint(plan?.error ?? `${dimensions} · ${hint}`);
  }

  showRoomMarker(room, point) {
    const tool = this.app.tool.room;
    const context = roomPlacementContext(room, point, tool);
    const { supportIds } = context;
    this.creationSupports = new Set(OPENING_SUPPORTS.map((side) => supportIds[side]).filter((id) => id > 0));
    const anchor = supportIds[SIDE_NB[tool.wall]];
    if (anchor > 0) this.creationSupports.add(anchor);
    for (const id of context.span?.supportIds ?? []) if (id > 0) this.creationSupports.add(id);
    const plan = (tool.panel || tool.spanAxis) && planRoomElement(room, tool, point, context);
    const { frame, ghost, ghostFrame } = this.marker.userData;
    this.marker.visible = true;
    this.marker.position.set(0, 0, 0);
    this.marker.rotation.set(0, 0, 0);
    frame.visible = false;
    ghost.visible = ghostFrame.visible = !!plan;
    this.showCross(point);
    if (plan) { this.placeBox(ghost, plan.box); this.placeBox(ghostFrame, plan.box); }
    const size = plan && tool.spanAxis ? `${tool.title} · ${[plan.box.sx, plan.box.sy, plan.box.sz].map(Math.round).join(' × ')} мм · ` : '';
    const hint = tool.panel && this.app.tool.options ? `${TOOL_HINT} · ${TOOL_OPTIONS_HINT}` : TOOL_HINT;
    this.setHint(size + hint);
  }

  async placeRoomAtCursor() {
    const { app } = this;
    const { room } = app.project;
    const { tool } = app;
    const point = { ...this.creationCursor };
    if (roomCursorOverlaps(room, point) && !(await confirmDialog('Установка элемента комнаты', 'Создать деталь поверх другой детали?'))) return;
    if (app.project.room !== room || app.tool !== tool || !app.editingRoom) return;
    app.placeRoomElement(point);
  }

  placeCreationAtCursor() {
    const { app } = this;
    if (app.editingRoom) {
      if (app.tool?.room) this.placeRoomAtCursor();
      return true;
    }
    if (!this.creationTarget || !this.creationCursor) return false;
    const point = { ...this.creationCursor };
    app.placeAt({ ...point, supportIds: placementNeighbors(app.product, point) });
    return true;
  }

  pixelSize(point) {
    const dist = this.camera.position.distanceTo(point);
    return (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.renderer.domElement.clientHeight / MM;
  }

  startProductDrag(e, product) {
    const c = productCenter(product);
    const point = new THREE.Vector3(c.x * MM, c.y * MM, c.z * MM);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).setY(0).normalize();
    const depth = right.clone().cross(UP);
    return { center: { ...c, y: product.y }, origin: { x: product.x, y: product.y, z: product.z }, right, depth,
      screenX: e.clientX, screenY: e.clientY, raise: e.shiftKey, px: this.pixelSize(point), moved: false };
  }

  dragPosition(e, drag) {
    const step = e.altKey ? 1 : DRAG_STEP;
    const snap = (distance) => Math.round(distance / step) * step;
    const dx = (e.clientX - drag.screenX) * drag.px;
    const dy = (e.clientY - drag.screenY) * drag.px;
    return drag.raise ? { x: snap(drag.right.x * dx), y: snap(-dy), z: snap(drag.right.z * dx) }
      : { x: snap(drag.right.x * dx + drag.depth.x * dy), y: 0, z: snap(drag.right.z * dx + drag.depth.z * dy) };
  }

  orbitCamera(dx, dy) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const angles = new THREE.Spherical().setFromVector3(offset);
    angles.theta -= THREE.MathUtils.degToRad(dx / 8);
    angles.phi = THREE.MathUtils.clamp(angles.phi - THREE.MathUtils.degToRad(dy / 8), 0.025, Math.PI - 0.025);
    this.camera.position.setFromSpherical(angles).add(this.controls.target);
    this.controls.update();
  }

  panCamera(dx, dy) {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const scale = distance * THREE.MathUtils.degToRad(1 / 80);
    const offset = new THREE.Vector3(-dx * scale, dy * scale, 0).applyQuaternion(this.camera.quaternion);
    this.camera.position.add(offset);
    this.controls.target.add(offset);
    this.controls.update();
  }

  onDown(e, capture = true) {
    if (!e.isPrimary || e.pointerType === 'touch' || e.button > 2) return;
    const el = this.renderer.domElement;
    el.focus({ preventScroll: true });
    if (capture) el.setPointerCapture(e.pointerId);
    this.setPointer(e);
    const { app } = this;
    const down = { button: e.button, x: e.clientX, y: e.clientY, pointerId: e.pointerId, ctrlKey: e.ctrlKey, moved: false };
    this.down = down;
    if (app.placement) {
      if (e.button === 0) down.placement = this.startProductDrag(e, app.placement);
      return;
    }
    if (this.creationTarget && e.button === 0) {
      this.updateCreationCursor(e);
      this.showCreationMarker();
      this.render();
    }
    if (app.editingRoom) {
      const target = this.roomHit();
      down.target = target?.object.userData;
      if (e.button !== 0 || app.tool) return;
      app.selectRoom(down.target?.roomId ?? 0);
      if (!target) return;
      const element = app.roomSelected;
      const box = roomElementBox(app.project.room, element);
      const normal = AXIS_VECTOR[SIDE_AXIS[element.wall] ?? 'y'];
      down.drag = { room: true, roomObject: element.kind === KIND.ROOM_ELEMENT, pointerX: e.clientX, pointerY: e.clientY,
        previousX: e.clientX, previousY: e.clientY, shift: e.shiftKey,
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, target.point), start: target.point,
        origin: { x: box.l, y: box.b, z: box.g }, px: this.pixelSize(target.point), moved: false };
      return;
    }
    const hit = this.hit();
    const target = hit ?? this.raycaster.intersectObjects(this.productHits, false)[0];
    down.target = target?.object.userData;
    down.roomProduct = app.mode === 'room' && !!target;
    const partId = hit?.object.userData.productId === app.activeId ? hit.object.userData.partId : 0;
    if (e.button === 2) {
      down.partMenu = app.mode === 'product' && !app.tool && !!partId;
      return;
    }
    if (e.button !== 0 || app.tool) return;
    if (!target) {
      if (app.mode === 'product' && !down.ctrlKey) app.select(0);
      return;
    }
    if (app.mode === 'room' || app.moveMode) {
      const { productId } = down.target;
      if (app.activeId !== productId) app.activate(productId, app.mode);
      if (app.moveMode) down.drag = { product: true, ...this.startProductDrag(e, app.product) };
      return;
    }
    if (!partId) return;
    app.select(partId, { toggle: down.ctrlKey });
    if (down.ctrlKey) return;
    const part = app.movable;
    const axes = ['x', 'y', 'z'].filter((axis) => canMove(app.product, part, axis));
    if (!(e.shiftKey ? axes.includes('z') : app.sub !== 'overview')) return;
    if (!axes.length) return;
    const angle = yaw(app.product);
    const normal = new THREE.Vector3(0, 0, 1).applyAxisAngle(UP, angle);
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    if (Math.abs(normal.dot(direction)) <= 0.3) normal.copy(direction).negate();
    down.drag = {
      axes, angle, start: hit.point.clone(), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point),
      origin: { x: part.box.l, y: part.box.b, z: part.box.g }, px: this.pixelSize(hit.point), moved: false,
    };
  }

  dragSelection(e, down) {
    let d = this.drag;
    const { app } = this;
    if (d.room) {
      const step = e.altKey ? 1 : DRAG_STEP;
      const snap = (value) => Math.round(value / step) * step;
      if (d.roomObject) {
        if (d.shift !== e.shiftKey) {
          const box = roomElementBox(app.project.room, app.roomSelected);
          d.origin = { x: box.l, y: box.b, z: box.g };
          d.pointerX = d.previousX;
          d.pointerY = d.previousY;
          d.shift = e.shiftKey;
        }
        const dx = e.clientX - d.pointerX;
        const dy = e.clientY - d.pointerY;
        d.previousX = e.clientX;
        d.previousY = e.clientY;
        const view = this.camera.position.clone().sub(this.controls.target);
        const front = Math.abs(view.x) < Math.abs(view.z / 2);
        const sign = Math.sign(front ? view.z : view.x) || 1;
        const target = e.shiftKey ? { y: d.origin.y - snap(dy * d.px) }
          : { x: d.origin.x + snap((front ? dx : dy) * sign * d.px),
            z: d.origin.z + snap((front ? dy : -dx) * sign * d.px) };
        if (app.moveRoomElement(target, true)) d.moved = true;
        return;
      }
      const point = this.raycaster.ray.intersectPlane(d.plane, new THREE.Vector3());
      if (!point) return;
      const delta = point.sub(d.start).multiplyScalar(1 / MM);
      const target = d.plane.normal.y && e.shiftKey ? { y: d.origin.y + snap((down.y - e.clientY) * d.px) }
        : { x: d.origin.x + snap(delta.x), y: d.origin.y + snap(delta.y), z: d.origin.z + snap(delta.z) };
      if (app.moveRoomElement(target, true)) d.moved = true;
      return;
    }
    if (d.product) {
      if (d.raise !== e.shiftKey) this.drag = d = { product: true, ...this.startProductDrag(e, app.product), moved: d.moved };
      const delta = this.dragPosition(e, d);
      if (app.dragProductTo({ x: d.origin.x + delta.x, y: d.origin.y + delta.y, z: d.origin.z + delta.z })) d.moved = true;
      return;
    }
    const step = e.altKey ? 1 : DRAG_STEP;
    const snap = (v) => Math.round(v / step) * step;
    const want = {};
    if (e.shiftKey) want.z = d.origin.z + snap((e.clientX - down.x) * d.px);
    else if (app.sub !== 'overview') {
      const p = this.raycaster.ray.intersectPlane(d.plane, new THREE.Vector3());
      if (!p) return;
      const delta = p.sub(d.start).applyAxisAngle(UP, -d.angle);
      want.x = d.origin.x + snap(delta.x / MM);
      want.y = d.origin.y + snap(delta.y / MM);
    }
    for (const axis of d.axes) if (axis in want && app.dragTo(axis, want[axis])) d.moved = true;
    const part = app.movable;
    if (part) this.setHint(`X: ${Math.round(part.box.l)}   Y: ${Math.round(part.box.b)}   Z: ${Math.round(part.box.g)}   ( Shift — по глубине, Alt — шаг 1 мм )`);
  }

  onMove(e) {
    if (e.pointerType === 'touch') return;
    this.setPointer(e);
    const { app } = this;
    const down = this.down;
    if (!down) {
      if (this.creationTarget && e.buttons === 0) {
        this.updateCreationCursor(e);
        this.showCreationMarker();
        this.render();
      } else this.moveRoomWithShift(e);
      return;
    }
    if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= DRAG_START) return;
    down.moved = true;
    const dx = e.clientX - (down.lastX ?? down.x);
    const dy = e.clientY - (down.lastY ?? down.y);
    down.lastX = e.clientX;
    down.lastY = e.clientY;
    if ((e.buttons & BOTH_BUTTONS) === BOTH_BUTTONS) {
      down.chord = true;
      if (!down.roomProduct || !down.drag?.product) this.panCamera(dx, dy);
      else this.trackDrag(e, down);
      return;
    }
    if (down.chord) return;
    if (this.creationTarget) this.rememberCreationPointer(e);
    if (e.buttons === LEFT_BUTTON && down.button === 0) {
      if (down.placement && app.placement) {
        if (down.placement.raise !== e.shiftKey) down.placement = this.startProductDrag(e, app.placement);
        const { center } = down.placement;
        const delta = this.dragPosition(e, down.placement);
        app.movePlacement({ x: center.x + delta.x, y: center.y + delta.y, z: center.z + delta.z });
        return;
      }
      if (down.drag) { this.trackDrag(e, down); return; }
    }
    if (e.buttons === RIGHT_BUTTON && down.partMenu) return;
    if (e.buttons === LEFT_BUTTON || e.buttons === RIGHT_BUTTON || e.buttons === MIDDLE_BUTTON) {
      this.orbitCamera(dx, dy);
    }
  }

  moveRoomWithShift(e) {
    const { app } = this;
    const element = app.roomSelected;
    if (!e.shiftKey || e.buttons || !app.editingRoom || app.tool || element?.kind !== KIND.ROOM_ELEMENT || roomAxisFixed(element, 'y')) {
      this.endRoomShiftDrag();
      return;
    }
    const drag = this.roomShiftDrag;
    if (!drag) {
      const box = roomElementBox(app.project.room, element);
      const center = new THREE.Vector3(box.cx * MM, box.cy * MM, box.cz * MM);
      this.roomShiftDrag = { pointer: e.clientY, y: box.b, px: this.pixelSize(center), moved: false };
      app.beginDrag();
      return;
    }
    const step = e.altKey ? 1 : DRAG_STEP;
    const delta = Math.round((drag.pointer - e.clientY) * drag.px / step) * step;
    if (app.moveRoomElement({ y: drag.y + delta }, true)) drag.moved = true;
  }

  endRoomShiftDrag() {
    const drag = this.roomShiftDrag;
    if (!drag) return;
    this.roomShiftDrag = null;
    this.app.endDrag(drag.moved);
  }

  trackDrag(e, down) {
    if (!this.drag) {
      this.drag = down.drag;
      this.app.beginDrag();
    }
    this.dragSelection(e, down);
  }

  onUp(e) {
    const down = this.down;
    if (!down || e.pointerId !== down.pointerId) return;
    const { app } = this;
    this.down = null;
    if (this.drag) {
      const moved = this.drag.moved;
      this.drag = null;
      app.endDrag(moved);
      this.setHint('');
      return;
    }
    if (e.type !== 'pointerup' || down.button !== e.button || down.chord || down.placement || app.placement) return;
    if (e.button === 1 && app.tool) { app.cancelPlacement(); return; }
    if (e.button === 2) {
      if (app.tool) {
        if (!down.moved && this.creationCursor && this.creationTarget && app.tool.options) {
          this.setPointer(e);
          this.updateCreationCursor(e);
          app.tool.options({ ...this.creationCursor });
        }
        return;
      }
      if ((!down.moved || down.partMenu) && down.target) {
        app.emit('scene-context', { target: down.target, clientX: down.x, clientY: down.y });
      }
      return;
    }
    if (e.button !== 0 || down.moved) return;
    this.setPointer(e);
    if (this.placeCreationAtCursor()) return;
    if (app.mode !== 'product' || down.ctrlKey) return;
    const hit = this.hit();
    if (!hit) { app.select(0); return; }
    const { productId } = hit.object.userData;
    if (productId !== app.activeId) app.activate(productId);
  }
}
