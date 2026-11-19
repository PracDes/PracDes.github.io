const LIST_FIELDS = ['pos', 'kromFor', 'krepFor', 'krepForKod', 'krepToId', 'krepTo'];

export function parseIdList(text) {
  const set = new Set();
  for (const chunk of String(text ?? '').split('\\')) {
    if (chunk === '') continue;
    const n = Number(chunk);
    if (Number.isInteger(n)) set.add(n);
  }
  return set;
}

export class Db {
  constructor({ meta, keys, rows }) {
    this.meta = meta;
    this.letter = meta.productTip[0];
    this.rows = rows.map((r) => {
      const row = {};
      keys.forEach((k, i) => { if (r[i] != null) row[k] = r[i]; });
      for (const f of LIST_FIELDS) row[f + 'Set'] = row[f] ? parseIdList(row[f]) : null;
      return row;
    }).sort((a, b) => a.kod - b.kod);
    this.byKod = new Map(this.rows.map((r) => [r.kod, r]));
    this.cache = new Map();
  }

  get(kod) { return this.byKod.get(Number(kod)) ?? null; }

  forProduct(row) { return (row.tip ?? '').includes(this.letter); }

  indexed(field, id) {
    const key = field + ':' + id;
    let list = this.cache.get(key);
    if (!list) {
      list = this.rows.filter((r) => r[field + 'Set']?.has(id) && this.forProduct(r));
      this.cache.set(key, list);
    }
    return list;
  }

  byPos(kind) { return this.indexed('pos', kind); }
  edgesFor(kind) { return this.indexed('kromFor', kind); }
  krepFor(kind) { return this.indexed('krepFor', kind); }

  krepCatalog() {
    const key = 'krepCatalog';
    if (!this.cache.has(key)) {
      const names = new Set(this.rows.filter((row) => row.krepForSet?.size || row.krepForKodSet?.size).map((row) => row.name));
      this.cache.set(key, this.rows.filter((row) => names.has(row.name)));
    }
    return this.cache.get(key);
  }

  sostav(row) {
    return String(row?.sostav ?? '').split('|').filter((s) => s !== '');
  }

  komplekt(row) {
    const counts = new Map();
    for (const item of String(row?.komplekt ?? '').split('|')) {
      const sub = this.get(item);
      if (item !== '' && sub) counts.set(sub.kod, (counts.get(sub.kod) ?? 0) + 1);
    }
    return counts;
  }
}
