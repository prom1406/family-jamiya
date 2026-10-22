'use strict';
// محاكاة بسيطة لـ Firestore (في الذاكرة) تكفي لاختبار منطق core.js دون الاتصال بأي خدمة
const DEL = { __del: 1 }, TS = { __ts: 1 };
const FV = { serverTimestamp: () => TS, delete: () => DEL, arrayRemove: (...v) => ({ __rm: v }), arrayUnion: (...v) => ({ __un: v }) };
function makeDb() {
  const store = new Map(); let seq = 0;
  const apply = (cur, patch) => { const o = { ...cur }; for (const [k, v] of Object.entries(patch)) {
    if (v === DEL) delete o[k]; else if (v === TS) o[k] = new Date(Date.now());
    else if (v && v.__rm) o[k] = (o[k] || []).filter(x => !v.__rm.includes(x)); else if (v && v.__un) o[k] = [...new Set([...(o[k] || []), ...v.__un])]; else o[k] = v; } return o; };
  const snap = (path, ref) => { const r = store.get(path); return { id: path.split('/').pop(), exists: !!r, ref, data: () => (r ? JSON.parse(JSON.stringify(r.data)) : undefined), createTime: { toMillis: () => (r ? r.t : 0) } }; };
  const docRef = path => { const ref = { id: path.split('/').pop(), path,
    get: async () => snap(path, ref),
    set: async d => { store.set(path, { data: apply({}, d), t: store.get(path)?.t || Date.now() }); },
    create: async d => { if (store.has(path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(path, { data: apply({}, d), t: Date.now() }); },
    update: async d => { const r = store.get(path); if (!r) throw new Error('NOT_FOUND ' + path); r.data = apply(r.data, d); },
    collection: n => colRef(path + '/' + n) }; return ref; };
  const colRef = (path, filters = [], lim = 1e9) => ({ path,
    doc: id => docRef(path + '/' + (id || 'auto' + (++seq))),
    where: (f, op, v) => colRef(path, [...filters, [f, op, v]], lim),
    limit: n => colRef(path, filters, n),
    select: () => colRef(path, filters, lim),
    get: async () => { const docs = []; for (const [p, r] of store) { const m = p.slice(0, path.length + 1) === path + '/' && !p.slice(path.length + 1).includes('/'); if (!m) continue;
      if (filters.every(([f, , v]) => r.data[f] === v)) docs.push(snap(p, docRef(p))); }
      const d = docs.slice(0, lim); return { docs: d, empty: !d.length, forEach: fn => d.forEach(fn) }; } });
  const db = { _store: store, doc: p => docRef(p), collection: n => colRef(n),
    getAll: async (...refs) => Promise.all(refs.map(r => r.get())),
    batch: () => { const ops = []; return { set: (r, d) => ops.push(() => r.set(d)), update: (r, d) => ops.push(() => r.update(d)), commit: async () => { for (const o of ops) await o(); } }; },
    runTransaction: async fn => { const pend = []; const res = await fn({ get: r => r.get(), update: (r, d) => pend.push(() => r.update(d)) }); for (const p of pend) await p(); return res; },
    seed: (path, data, t) => store.set(path, { data, t: t || Date.now() }),
    all: col => [...store].filter(([p]) => p.startsWith(col + '/') && !p.slice(col.length + 1).includes('/')).map(([p, r]) => ({ id: p.split('/').pop(), ...r.data })) };
  return db;
}
module.exports = { makeDb, FV };
