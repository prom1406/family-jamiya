'use strict';
const assert = require('assert');
const { makeDb, FV } = require('./fake');
const L = require('../lib');
const logs = []; const logger = { info: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) };
let sent = [], sendImpl = null;
const messaging = { sendEach: async msgs => { sent.push(...msgs); return sendImpl ? sendImpl(msgs) : { responses: msgs.map(() => ({ success: true })) }; } };
const mk = (env = {}) => { const db = makeDb(); return { db, core: require('../core')({ db, FV, messaging, logger, ownerEmail: 'owner@x.com', env }) }; };
let pass = 0; const t = async (name, fn) => { sent = []; sendImpl = null; try { await fn(); pass++; console.log('✓', name); } catch (e) { console.error('✗', name, '\n ', e.stack); process.exitCode = 1; } };
const tailOf = s => String(s).slice(-24);
const WEB = 'w'.repeat(30) + 'WEBTOKEN', IOS = 'i'.repeat(30) + 'IOSTOKEN';

(async () => {
  await t('deliver: يرسل للآيفون مع apns ويتجاوز الجهاز الذي أقرّ بالتسليم', async () => {
    const { db, core } = mk(); db.seed('users/u1', { fcmTokens: [WEB, IOS] });
    db.seed('notifs/n1', { toUid: 'u1', title: 'عنوان', body: 'نص', jid: 'J1', tag: 'tg', pushed: false, ack: [tailOf(WEB)] });
    const ref = db.doc('notifs/n1'); await core.deliver(ref, (await ref.get()).data(), {});
    assert.strictEqual(sent.length, 1); const m = sent[0];
    assert.strictEqual(m.token, IOS); assert.strictEqual(m.apns.payload.aps.alert.title, 'عنوان'); assert.strictEqual(m.apns.payload.aps.sound, 'default');
    assert.strictEqual(m.data.jid, 'J1'); assert.strictEqual(m.data.tag, 'tg_u1'); assert.ok(m.webpush);
    for (const v of Object.values(m.data)) assert.strictEqual(typeof v, 'string');
    const d = (await ref.get()).data(); assert.strictEqual(d.pushed, true); assert.ok(!d.noPush);
  });
  await t('deliver: بلا رموز ← pushed و noPush دون إرسال', async () => {
    const { db, core } = mk(); db.seed('users/u1', {}); db.seed('notifs/n1', { toUid: 'u1', title: 'a', body: 'b', pushed: false });
    const ref = db.doc('notifs/n1'); await core.deliver(ref, (await ref.get()).data(), {});
    assert.strictEqual(sent.length, 0); const d = (await ref.get()).data(); assert.ok(d.pushed && d.noPush);
  });
  await t('deliver: كل الأجهزة أقرّت ← pushed فقط', async () => {
    const { db, core } = mk(); db.seed('users/u1', { fcmTokens: [WEB] }); db.seed('notifs/n1', { toUid: 'u1', title: 'a', body: 'b', pushed: false, ack: [tailOf(WEB)] });
    const ref = db.doc('notifs/n1'); await core.deliver(ref, (await ref.get()).data(), {});
    assert.strictEqual(sent.length, 0); const d = (await ref.get()).data(); assert.ok(d.pushed && !d.noPush);
  });
  await t('deliver: رمز غير مسجّل يُحذف، وفشل الكل ← noPush', async () => {
    const { db, core } = mk(); db.seed('users/u1', { fcmTokens: [WEB, IOS] }); db.seed('notifs/n1', { toUid: 'u1', title: 'a', body: 'b', pushed: false });
    sendImpl = msgs => ({ responses: msgs.map(m => m.token === WEB ? { success: false, error: { code: 'messaging/registration-token-not-registered', message: 'x' } } : { success: false, error: { code: 'messaging/internal-error', message: 'y' } }) });
    const ref = db.doc('notifs/n1'); await core.deliver(ref, (await ref.get()).data(), {});
    assert.deepStrictEqual((await db.doc('users/u1').get()).data().fcmTokens, [IOS]); assert.ok((await ref.get()).data().noPush);
  });
  await t('deliver: يرسل لأحدث 5 أجهزة فقط', async () => {
    const { db, core } = mk(); const toks = Array.from({ length: 8 }, (_, i) => 'tok' + i + 'x'.repeat(30));
    db.seed('users/u1', { fcmTokens: toks }); db.seed('notifs/n1', { toUid: 'u1', title: 'a', body: 'b', pushed: false });
    const ref = db.doc('notifs/n1'); await core.deliver(ref, (await ref.get()).data(), {});
    assert.deepStrictEqual(sent.map(m => m.token), toks.slice(-5));
  });
  await t('claim: لا يُحجز المستند مرتين ولا بعد pushed', async () => {
    const { db, core } = mk(); db.seed('notifs/n1', { toUid: 'u1', pushed: false }); const ref = db.doc('notifs/n1');
    assert.ok(await core.claim(ref)); assert.strictEqual(await core.claim(ref), null);
    db.seed('notifs/n2', { pushed: true }); assert.strictEqual(await core.claim(db.doc('notifs/n2')), null);
  });
  await t('notifyNewUser: يُشعر المالك ويعلّم المشترك، وبلا مالك يؤجل', async () => {
    const { db, core } = mk(); db.seed('users/new1', { name: 'سالم', phone: '0500000000', email: 's@x.com', ownerNotified: false });
    await core.notifyNewUser('new1', (await db.doc('users/new1').get()).data());
    assert.strictEqual(db.all('notifs').length, 0); assert.strictEqual((await db.doc('users/new1').get()).data().ownerNotified, false);
    db.seed('users/own', { email: 'owner@x.com' });
    await core.notifyNewUser('new1', (await db.doc('users/new1').get()).data());
    const n = db.all('notifs'); assert.strictEqual(n.length, 1); assert.strictEqual(n[0].toUid, 'own'); assert.strictEqual(n[0].kind, 'admin'); assert.ok(n[0].body.includes('سالم'));
    assert.strictEqual((await db.doc('users/new1').get()).data().ownerNotified, true);
    await core.notifyNewUser('new1', (await db.doc('users/new1').get()).data()); assert.strictEqual(db.all('notifs').length, 1);
  });
  await t('notifyInvite: بالجوال ثم البريد، ويتجاوز الداعي نفسه والقديمة', async () => {
    const { db, core } = mk(); db.seed('phones/0555', { uid: 'uP' }); db.seed('users/uE', { email: 'e@x.com' });
    db.seed('invites/i1', { status: 'pending', phone: '0555', inviterName: 'أحمد', jamiyaName: 'جمعية' });
    db.seed('invites/i2', { status: 'pending', email: 'E@x.com', invitedBy: 'someone' });
    db.seed('invites/i3', { status: 'pending', phone: '0555', invitedBy: 'uP' });
    db.seed('invites/i4', { status: 'pending', phone: '0555' }, Date.now() - 9 * 864e5);
    for (const id of ['i1', 'i2', 'i3', 'i4']) { const r = db.doc('invites/' + id), s = await r.get(); await core.notifyInvite(id, s.data(), s.createTime.toMillis()); }
    const n = db.all('notifs'); assert.deepStrictEqual(n.map(x => x.toUid).sort(), ['uE', 'uP']);
    assert.ok(n.find(x => x.toUid === 'uP').body.includes('أحمد')); for (const id of ['i1', 'i2', 'i3', 'i4']) assert.strictEqual((await db.doc('invites/' + id).get()).data().ntf, true);
  });
  const realNow = Date.now; const at = (y, m, d) => { Date.now = () => Date.UTC(y, m, d, 5, 0, 0); }; // 08:00 بتوقيت الرياض
  await t('reminderJob: تذكير قبل يومين للأعضاء ولا تكرار في التشغيل الثاني', async () => {
    const { db, core } = mk(); at(2026, 9, 23);
    db.seed('jamiyat/j1', { name: 'جمعية العائلة', startDate: '2026-10-01', frequency: 'monthly', count: 5, turns: ['uA', 'uB', 'uC', 'uD', 'uE'], lastDay: 25, payDay: 27, amount: 100, creatorUid: 'uA' });
    const k1 = await core.reminderJob(); const n = db.all('notifs');
    assert.strictEqual(k1, 4); assert.deepStrictEqual(n.map(x => x.toUid).sort(), ['uB', 'uC', 'uD', 'uE']);
    assert.ok(n.every(x => x.kind === 'remind' && x.pushed === false && x.jid === 'j1' && x.body.includes('100')));
    assert.strictEqual(await core.reminderJob(), 0); assert.strictEqual(db.all('notifs').length, 4);
    Date.now = realNow;
  });
  await t('reminderJob: يوم الموعد يُشعر المشرف بعدد غير المسددين، ومن سدّد لا يُذكَّر', async () => {
    const { db, core } = mk(); at(2026, 9, 25);
    db.seed('jamiyat/j1', { name: 'ج', startDate: '2026-10-01', frequency: 'monthly', count: 5, turns: ['uA', 'uB', 'uC'], lastDay: 25, payDay: 27, amount: 100, creatorUid: 'uA' });
    db.seed('jamiyat/j1/payments/p1', { uid: 'uB', amount: 100, status: 'confirmed' });
    await core.reminderJob(); const n = db.all('notifs');
    assert.deepStrictEqual(n.filter(x => x.tag.startsWith('ar_')).map(x => x.toUid), ['uC']);
    const s = n.find(x => x.tag.startsWith('as_')); assert.ok(s && s.toUid === 'uA' && s.body.startsWith('1 عضو'));
    Date.now = realNow;
  });
  await t('reminderJob: يوم الاستلام قبل يوم', async () => {
    const { db, core } = mk(); at(2026, 9, 26);
    db.seed('jamiyat/j1', { name: 'ج', startDate: '2026-10-01', frequency: 'monthly', count: 5, turns: ['uA', 'uB'], lastDay: 25, payDay: 27, amount: 100, creatorUid: 'uA' });
    await core.reminderJob(); const n = db.all('notifs'); // 26 = متأخر يوماً (آخر موعد 25) + استلام الغد
    const recv = n.filter(x => x.tag.endsWith('_recv1')); assert.strictEqual(recv.length, 1); assert.strictEqual(recv[0].toUid, 'uA'); assert.ok(recv[0].title.includes('غداً'));
    assert.deepStrictEqual(n.filter(x => x.tag.startsWith('ar_') && x.tag.endsWith('_late1')).map(x => x.toUid), ['uB']); assert.strictEqual(n.length, 3);
    Date.now = realNow;
  });
  await t('reminderJob: التعاون العائلي (بدون التزام ومع التزام)', async () => {
    const { db, core } = mk(); at(2026, 9, 23);
    db.seed('jamiyat/f1', { type: 'family', mode: 'monthly', name: 'تعاون', famStart: '2026-10', monthlyDay: 23, creatorUid: 'boss', memberUids: ['boss', 'm1', 'm2'] });
    db.seed('jamiyat/f1/pledges/m1', { from: 0, amount: 50 });
    await core.reminderJob(); const n = db.all('notifs').sort((a, b) => a.toUid.localeCompare(b.toUid));
    assert.deepStrictEqual(n.map(x => x.toUid), ['m1', 'm2']); assert.ok(n[0].body.includes('50')); assert.ok(n[1].body.includes('حدّد قيمتك'));
    Date.now = realNow;
  });
  await t('واتساب: يُرسل فقط عند وجود الأسرار وموافقة المستخدم ونوع التذكير', async () => {
    const calls = []; const f = globalThis.fetch; globalThis.fetch = async (u, o) => { calls.push([u, JSON.parse(o.body)]); return { ok: true, text: async () => '{}' }; };
    try {
      const { db, core } = mk({ WA_TOKEN: 't', WA_PHONE_ID: 'pid', WA_TEMPLATE: 'tpl' });
      db.seed('users/u1', { phone: '0569090301' }); db.seed('users/u2', { phone: '0569090302', waOptIn: false });
      for (const [id, to, kind] of [['a', 'u1', 'remind'], ['b', 'u2', 'remind'], ['c', 'u1', 'invite']]) db.seed('notifs/' + id, { toUid: to, kind, title: 'ت', body: 'ب', pushed: false });
      const cache = {}; for (const id of ['a', 'b', 'c']) { const r = db.doc('notifs/' + id); await core.deliver(r, (await r.get()).data(), cache); }
      assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0][1].to, '966569090301');
    } finally { globalThis.fetch = f; }
  });
  await t('lib: monthIdx/dayIn الشهرية والأسبوعية', async () => {
    assert.strictEqual(L.monthIdx({ startDate: '2026-10-01' }, { y: 2026, m: 11, d: 5 }), 2);
    assert.strictEqual(L.dayIn({ startDate: '2026-10-01', frequency: 'monthly' }, 0, 31), Date.UTC(2026, 9, 31));
    assert.strictEqual(L.dayIn({ startDate: '2026-02-01', frequency: 'monthly' }, 0, 31), Date.UTC(2026, 1, 28));
    assert.strictEqual(L.monthIdx({ startDate: '2026-10-01', frequency: 'weekly' }, { y: 2026, m: 9, d: 15 }), 2);
  });
  console.log(`\n${pass} اختباراً نجح`);
  if (process.exitCode) console.log('بعض الاختبارات فشلت');
})();
