'use strict';
// منطق الإرسال والتذكيرات (يُحقَن فيه db وmessaging وغيرهما، فيمكن اختباره بمحاكاة دون الاتصال بـ Firebase)
const L = require('./lib');
module.exports = function makeCore({ db, FV, messaging, logger, ownerEmail, env }) {
const tail = t => String(t).slice(-24); // بصمة الجهاز في حقل ack (نفس ما يكتبه التطبيق)

/* ---------- مستندات الإشعارات ---------- */
const notifRef = () => db.collection('notifs').doc();
const notifData = (to, title, body, kind, tag, jid) => ({ toUid: to, fromUid: 'system', title, body, jid: jid || '', kind, tag, createdAt: FV.serverTimestamp(), pushed: false, read: false });

/* ---------- واتساب الرسمي (اختياري): يعمل فقط إن وُجدت WA_TOKEN و WA_PHONE_ID و WA_TEMPLATE في functions/.env ---------- */
async function waSend(to, title, body) {
  const e = env;
  const r = await fetch(`https://graph.facebook.com/v21.0/${e.WA_PHONE_ID}/messages`, { method: 'POST',
    headers: { Authorization: 'Bearer ' + e.WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: e.WA_TEMPLATE, language: { code: e.WA_LANG || 'ar' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: L.waClean(title) }, { type: 'text', text: L.waClean(body) }] }] } }) });
  const txt = await r.text(); if (!r.ok) logger.error('whatsapp failed', r.status, txt.slice(0, 300));
  return { ok: r.ok };
}
async function sendWA(info, n) {
  const e = env;
  if (!e.WA_TOKEN || !e.WA_PHONE_ID || !e.WA_TEMPLATE || !info.wa || !info.phone) return false;
  if (!(e.WA_KINDS || 'remind').split(',').map(s => s.trim()).includes(n.kind)) return false;
  return (await waSend(info.phone, n.title, n.body)).ok;
}

/* ---------- إرسال إشعار واحد إلى أجهزة المستلم ---------- */
// «حجز» المستند حتى لا يُرسَل مرتين إن تزامن المشغّل الفوري مع الكنّاس
async function claim(ref) {
  return db.runTransaction(async t => {
    const s = await t.get(ref), n = s.exists ? s.data() : null;
    if (!n || n.pushed) return null;
    if (n.claimedAt && Date.now() - n.claimedAt < 120000) return null;
    t.update(ref, { claimedAt: Date.now() });
    return n;
  });
}
async function deliver(ref, n, userCache) {
  const to = n.toUid;
  if (!to) return ref.update({ pushed: true, noPush: true });
  if (!(to in userCache)) {
    const s = await db.doc('users/' + to).get(), u = s.exists ? s.data() : {};
    userCache[to] = { tokens: Array.isArray(u.fcmTokens) ? u.fcmTokens : [], phone: L.waPhone(u.phone), wa: u.waOptIn !== false };
  }
  const info = userCache[to];
  try { await sendWA(info, n); } catch (e) { logger.error('whatsapp error', e.message); }
  const acked = Array.isArray(n.ack) ? n.ack : []; // أجهزة سلّمته لنفسها وهي مفتوحة: لا نكرره عليها
  if (!info.tokens.length) return ref.update({ pushed: true, noPush: true }); // بلا جهاز مسجّل: يُعرض عند فتح التطبيق
  const tokens = info.tokens.filter(t => !acked.includes(tail(t))).slice(-5); // أحدث 5 أجهزة
  if (!tokens.length) return ref.update({ pushed: true });
  const title = n.title || '', body = n.body || '';
  const data = { title, body, jid: n.jid || '', tag: (n.tag || ('n_' + ref.id)) + '_' + String(to).slice(0, 8) };
  // data للمتصفح (يعرضها الـ Service Worker) + apns لآيفون (إشعار ظاهر بصوت)
  const res = await messaging.sendEach(tokens.map(token => ({ token, data,
    webpush: { headers: { Urgency: 'high', TTL: '86400' } },
    apns: { headers: { 'apns-priority': '10' }, payload: { aps: { alert: { title, body }, sound: 'default' } } } })));
  let ok = 0; const dead = [];
  res.responses.forEach((r, i) => {
    if (r.success) { ok++; return; }
    const code = (r.error && r.error.code) || '';
    logger.warn('fcm failed', code, String(tokens[i]).slice(-8), (r.error && r.error.message) || '');
    if (/registration-token-not-registered|invalid-registration-token/.test(code)) dead.push(tokens[i]);
  });
  if (dead.length) await db.doc('users/' + to).update({ fcmTokens: FV.arrayRemove(...dead) }).catch(e => logger.error('token cleanup', e.message));
  await ref.update(ok ? { pushed: true } : { pushed: true, noPush: true });
}

/* ---------- أحداث: مشترك جديد ← المالك، ودعوة جديدة ← المدعوّ ---------- */
async function ownerUid() {
  const q = await db.collection('users').where('email', '==', ownerEmail).limit(1).get();
  return q.empty ? '' : q.docs[0].id;
}
async function notifyNewUser(id, u) {
  if (!u || u.ownerNotified !== false) return;
  const owner = await ownerUid(); if (!owner) return; // بلا مالك مسجّل نؤجل (لا نعلّم المشتركين)
  const b = db.batch();
  if (id !== owner) b.set(notifRef(), notifData(owner, 'مشترك جديد 🎉', `${u.name || 'عضو'}${u.phone ? ' — ' + u.phone : ''}${u.email ? ' — ' + u.email : ''}`, 'admin', 'nu_' + id, ''));
  b.update(db.doc('users/' + id), { ownerNotified: true });
  await b.commit();
}
async function notifyInvite(id, i, createdMs) {
  if (!i || i.status !== 'pending' || i.ntf) return;
  const b = db.batch(); let uid = '';
  if (Date.now() - createdMs < 7 * 864e5) { // الدعوات الأقدم من أسبوع تُعلَّم دون إشعار
    try {
      if (i.phone) { const s = await db.doc('phones/' + i.phone).get(); if (s.exists) uid = s.data().uid || ''; }
      if (!uid && i.email) { const q = await db.collection('users').where('email', '==', String(i.email).toLowerCase()).limit(1).get(); if (!q.empty) uid = q.docs[0].id; }
    } catch (e) { logger.error('invite lookup', e.message); return; }
    if (uid && uid !== i.invitedBy) b.set(notifRef(), notifData(uid, 'طلب انضمام جديد', `دعاك ${i.inviterName || 'المشرف'} للانضمام إلى «${i.jamiyaName || ''}»`, 'invite', 'inv_' + id, ''));
  }
  b.update(db.doc('invites/' + id), { ntf: true });
  await b.commit();
}


/* ---------- دردشة الجمعية: كل رسالة تُشعر بقية الأعضاء ---------- */
const audience = j => [...new Set([...(j.memberUids || []), j.creatorUid, j.deputyUid].filter(Boolean))];
const userName = async (uid, cache) => { if (!(uid in cache)) { const s = await db.doc('users/' + uid).get(); cache[uid] = (s.exists && s.data().name) || ''; } return cache[uid]; };
async function chatNotify(jid, mid, m) {
  if (!m || !m.uid || !m.text) return 0;
  try { await db.doc('autoRem/chat_' + mid).create({ at: FV.serverTimestamp() }); } catch (e) { return 0; } // لا تكرار إن أُعيد المشغّل
  const js = await db.doc('jamiyat/' + jid).get(); if (!js.exists) return 0;
  const j = { id: jid, ...js.data() }, to = audience(j).filter(u => u !== m.uid); if (!to.length) return 0;
  const who = (await userName(m.uid, {})) || 'عضو', text = String(m.text).replace(/\s+/g, ' ').trim().slice(0, 140);
  for (let i = 0; i < to.length; i += 200) {
    const b = db.batch();
    to.slice(i, i + 200).forEach(u => b.set(notifRef(), notifData(u, `دردشة «${j.name || 'الجمعية'}»`, `${who}: ${text}`, 'chatmsg', 'chat_' + jid, jid)));
    await b.commit();
  }
  return to.length;
}

/* ---------- بداية دورة جديدة / نهاية الجمعية ---------- */
async function cycleItems(j, idx, tms, items, names) {
  const cs = Math.round((tms - L.dayIn(j, idx, 1)) / L.DAYMS); if (cs < 0 || cs > 1) return; // يوم البداية (ويوم بعده تحسباً لفوات التشغيل)
  const to = audience(j); if (!to.length) return;
  if (idx >= j.count) { to.forEach(u => items.push({ key: `${j.id}_cend_${u}`, to: u, kind: 'cycle', title: `انتهت جمعية «${j.name}»`, body: `اكتملت جميع الدورات (${j.count}). جزاكم الله خيراً`, jid: j.id, tag: `cy_${j.id}_end` })); return; }
  const rec = j.turns && j.turns[idx], rn = rec ? await userName(rec, names) : '';
  const body = `${idx === 0 ? 'الدورة 1' : `انتهت الدورة ${idx} وبدأت الدورة ${idx + 1}`} من ${j.count}${rn ? ` — المستلم: ${rn}` : ''}`;
  to.forEach(u => items.push({ key: `${j.id}_c${idx}_${u}`, to: u, kind: 'cycle', title: idx === 0 ? `بدأت جمعية «${j.name}»` : `دورة جديدة في «${j.name}»`, body, jid: j.id, tag: `cy_${j.id}_${idx}` }));
}
async function famCycleItems(j, today, items) {
  if (j.mode !== 'monthly' || j.closed || today.d > 2) return;
  const k = L.famCycle(j, today); if (k < 0) return;
  audience(j).forEach(u => items.push({ key: `${j.id}_fc${k}_${u}`, to: u, kind: 'cycle', title: `شهر جديد في «${j.name}»`, body: 'بدأت دورة هذا الشهر من التعاون، راجع مساهمتك من التطبيق', jid: j.id, tag: `cy_${j.id}_f${k}` }));
}

/* ---------- التذكيرات التلقائية (نفس منطق التطبيق) ---------- */
async function famReminders(j, today, items) {
  if (j.mode !== 'monthly' || j.closed || !j.famStart || !j.monthlyDay) return;
  const k = L.famCycle(j, today); if (k < 0) return;
  const last = new Date(Date.UTC(today.y, today.m + 1, 0)).getUTCDate(), dd = today.d - Math.min(Number(j.monthlyDay), last);
  const stage = dd === 0 ? 'due' : dd === 3 ? 'late3' : ''; if (!stage) return;
  const sub = db.collection('jamiyat').doc(j.id);
  const pledges = {}; (await sub.collection('pledges').get()).forEach(d => { pledges[d.id] = d.data(); });
  const pays = (await sub.collection('payments').select('uid', 'amount', 'status').get()).docs.map(d => d.data());
  (j.memberUids || []).forEach(u => {
    if (u === j.creatorUid) return;
    const pl = pledges[u];
    if (!pl) { if (stage === 'due') items.push({ key: `${j.id}_f${k}_${u}_np`, to: u, title: `تعاون «${j.name}»`, body: 'حدّد قيمتك الشهرية الثابتة لتنضم إلى المساهمات', jid: j.id, tag: `af_${j.id}_${k}_np` }); return; }
    const from = Number(pl.from) || 0; if (k < from) return;
    let owed = 0; for (let i = from; i <= k; i++) owed += L.amtAt(pl, i); owed = L.r2(owed); let paid = 0; pays.forEach(p => { if (p.uid === u && (p.status === 'confirmed' || p.status === 'pending')) paid += Number(p.amount) || 0; });
    const left = L.r2(owed - L.r2(paid)); if (left <= 0.005) return;
    items.push({ key: `${j.id}_f${k}_${u}_${stage}`, to: u, title: `تذكير بمساهمة «${j.name}»`, body: `${stage === 'due' ? 'موعد مساهمة هذا الشهر اليوم' : 'تأخرت مساهمة هذا الشهر'}. المتبقي عليك ${L.fmt(left)} ريال${stage === 'due' ? '. يمكنك إبقاء مبلغك الشهري أو تعديله من التطبيق' : ''}`, jid: j.id, tag: `af_${j.id}_${k}_${stage}` });
  });
}
async function reminderJob() {
  const rt = new Date(Date.now() + 3 * 3600000), today = { y: rt.getUTCFullYear(), m: rt.getUTCMonth(), d: rt.getUTCDate() }, tms = Date.UTC(today.y, today.m, today.d);
  const jams = (await db.collection('jamiyat').limit(300).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const items = [], names = {}; // { key, to, title, body, jid, tag, kind? }
  for (const j of jams) {
    if (j.type === 'family') { await famCycleItems(j, today, items); await famReminders(j, today, items); continue; }
    if (!j.startDate || !j.count || !Array.isArray(j.turns)) continue;
    const idx = L.monthIdx(j, today); if (idx < 0 || idx > j.count) continue;
    await cycleItems(j, idx, tms, items, names); if (idx >= j.count) continue;
    const dd = Math.round((L.dayIn(j, idx, j.lastDay) - tms) / L.DAYMS), pd = Math.round((L.dayIn(j, idx, j.payDay) - tms) / L.DAYMS);
    const stage = dd === 2 ? 'pre2' : dd === 0 ? 'due' : dd === -1 ? 'late1' : dd === -3 ? 'late3' : dd === -7 ? 'late7' : '';
    const recvStage = pd === 1 ? 'recv1' : pd === 0 ? 'recv0' : '';
    if (!stage && !recvStage) continue;
    const turns = j.turns, recUid = turns[idx], staff = [...new Set([j.creatorUid, j.deputyUid].filter(Boolean))];
    const pays = stage ? (await db.collection('jamiyat').doc(j.id).collection('payments').select('uid', 'amount').get()).docs.map(d => d.data()) : [];
    const late = [];
    if (stage) [...new Set(turns)].forEach(u => { if (u === recUid && turns.filter(x => x === u).length === 1) return; const a = L.owing(j, turns, idx, pays, u); if (!a.owes) return; late.push(u);
      const msg = stage === 'pre2' ? 'يستحق آخر موعد للسداد بعد يومين' : stage === 'due' ? 'آخر موعد للسداد اليوم' : `متأخر ${-dd} ${-dd === 1 ? 'يوم' : 'أيام'}`;
      items.push({ key: `${j.id}_${idx}_${u}_${stage}`, to: u, title: `تذكير بقسط «${j.name}»`, body: `${msg}. المتبقي عليك ${L.fmt(a.remaining)} ريال`, jid: j.id, tag: `ar_${j.id}_${idx}_${stage}` }); });
    if (stage && late.length && ['due', 'late1', 'late3'].includes(stage)) staff.forEach(u => items.push({ key: `${j.id}_${idx}_${u}_s${stage}`, to: u, title: `جمعية «${j.name}»`,
      body: `${late.length} ${late.length === 1 ? 'عضو لم يسدد' : 'أعضاء لم يسددوا'} بعد`, jid: j.id, tag: `as_${j.id}_${idx}_${stage}` }));
    if (recvStage && recUid) items.push({ key: `${j.id}_${idx}_${recUid}_${recvStage}`, to: recUid, title: recvStage === 'recv1' ? 'دورك في الاستلام غداً 🎉' : 'اليوم موعد استلامك 🎉',
      body: `جمعية «${j.name}» — راجع الإيصالات وأكّد استلامك`, jid: j.id, tag: `ar_${j.id}_${idx}_${recvStage}` });
  }
  if (!items.length) return 0;
  // نتجاوز ما أُرسل سابقاً (علامات في autoRem)
  const sent = new Set();
  for (let i = 0; i < items.length; i += 100) {
    const snaps = await db.getAll(...items.slice(i, i + 100).map(x => db.doc('autoRem/' + x.key)));
    snaps.forEach(s => { if (s.exists) sent.add(s.id); });
  }
  const fresh = items.filter(x => !sent.has(x.key)); if (!fresh.length) return 0;
  for (let i = 0; i < fresh.length; i += 200) {
    const b = db.batch();
    fresh.slice(i, i + 200).forEach(x => { b.set(db.doc('autoRem/' + x.key), { at: FV.serverTimestamp() }); b.set(notifRef(), notifData(x.to, x.title, x.body, x.kind || 'remind', x.tag, x.jid)); });
    await b.commit();
  }
  logger.info('reminders created', fresh.length);
  return fresh.length;
}

return { notifRef, notifData, claim, deliver, notifyNewUser, notifyInvite, reminderJob, chatNotify };
};
