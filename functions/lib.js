'use strict';
// دوال حسابية بحتة منقولة حرفياً من الـ Worker (بدون أي وصول لقاعدة البيانات)
const waPhone = p => { const d = String(p || '').replace(/\D/g, ''); return /^05\d{8}$/.test(d) ? '966' + d.slice(1) : /^9665\d{8}$/.test(d) ? d : ''; };
const waClean = s => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 500) || '-';

const DAYS = { monthly: 0, tenday: 10, biweekly: 14, weekly: 7 };
const r2 = n => Math.round(n * 100) / 100;
const fmt = n => Number(r2(n)).toLocaleString('en-US', { maximumFractionDigits: 2 });
const DAYMS = 864e5;
function startParts(j) { const [y, m, d] = String(j.startDate).split('-').map(Number); return { y, m: m - 1, d }; }
function monthIdx(j, t) {
  const s = startParts(j), f = DAYS[j.frequency || 'monthly'] || 0;
  if (!f) return (t.y - s.y) * 12 + t.m - s.m;
  return Math.floor(Math.round((Date.UTC(t.y, t.m, t.d) - Date.UTC(s.y, s.m, s.d)) / DAYMS) / f);
}
function dayIn(j, idx, day) {
  const s = startParts(j), f = DAYS[j.frequency || 'monthly'] || 0;
  if (!f) {
    const first = new Date(Date.UTC(s.y, s.m + idx, 1)), last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last));
  }
  return Date.UTC(s.y, s.m, s.d + idx * f + Math.min(day, f) - 1);
}
function owing(j, turns, cur, pays, uid) { // عليه متبقٍ؟ (نفس accountFor في التطبيق)
  const sh = Math.max(1, turns.filter(x => x === uid).length); let n = 0; for (let k = 0; k <= cur; k++) n += sh - (turns[k] === uid ? 1 : 0); // كل سهم له دور
  const owed = r2(n * j.amount); let paid = 0; pays.forEach(p => { if (p.uid === uid) paid += Number(p.amount) || 0; });
  const remaining = r2(Math.max(0, owed - r2(paid)));
  return { remaining, owes: remaining > 0.005 };
}
const famCycle = (j, t) => { const [y, m] = String(j.famStart || '').split('-').map(Number); return y ? (t.y - y) * 12 + (t.m - (m - 1)) : -1; };
const amtAt = (pl, i) => { const h = Array.isArray(pl.hist) ? pl.hist : null; if (!h || !h.length) return Number(pl.amount) || 0; let a = Number(h[0].a) || 0; h.forEach(x => { if (Number(x.c) <= i) a = Number(x.a) || 0; }); return a; };

module.exports = { waPhone, waClean, DAYS, r2, fmt, DAYMS, startParts, monthIdx, dayIn, owing, famCycle, amtAt };
