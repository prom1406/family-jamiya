'use strict';
/* سِواء — مرسل الإشعارات والتذكيرات (Firebase Cloud Functions، الجيل الثاني)
   يحل محل Cloudflare Worker:
   • onNotifCreated: عند إنشاء مستند في notifs يُرسل الإشعار فوراً (بعد 15 ثانية ليُسلّمه التطبيق المفتوح بنفسه).
   • onUserCreated / onInviteCreated: إشعار المالك بمشترك جديد، وإشعار المدعوّ بدعوة جديدة.
   • sweep: كل 5 دقائق يلتقط ما فاته (إشعارات لم تُرسل، مشتركون ودعوات).
   • onChatCreated: رسالة جديدة في دردشة الجمعية ← إشعار لبقية الأعضاء.
   • reminders: الساعة 8 و12 بتوقيت الرياض ينشئ التذكيرات التلقائية وإشعارات بداية الدورات.
   • autoBroadcast: كل ساعة يرسل الإشعارات اليومية/الأسبوعية التي حدّدها المالك لجميع المستخدمين. */
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { REGION, SCHED_REGION, OWNER_EMAIL } = require('./config');

admin.initializeApp();
const db = admin.firestore(), FV = admin.firestore.FieldValue;
const core = require('./core')({ db, FV, messaging: admin.messaging(), logger, ownerEmail: OWNER_EMAIL, env: process.env });
const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.onNotifCreated = onDocumentCreated({ document: 'notifs/{id}', region: REGION, timeoutSeconds: 120, maxInstances: 20 }, async ev => {
  const ref = ev.data.ref; if ((ev.data.data() || {}).pushed) return;
  await sleep(15000); // أمهل التطبيق المفتوح ليسلّمه بنفسه ويكتب ack
  const n = await core.claim(ref); if (!n) return;
  try { await core.deliver(ref, n, {}); } catch (e) { logger.error('deliver failed', ref.id, e.message); await ref.update({ claimedAt: FV.delete() }).catch(() => {}); }
});
exports.onUserCreated = onDocumentCreated({ document: 'users/{uid}', region: REGION }, ev => core.notifyNewUser(ev.params.uid, ev.data.data()));
exports.onInviteCreated = onDocumentCreated({ document: 'invites/{id}', region: REGION }, ev => core.notifyInvite(ev.params.id, ev.data.data(), ev.data.createTime.toMillis()));

exports.onChatCreated = onDocumentCreated({ document: 'jamiyat/{jid}/chat/{mid}', region: REGION, maxInstances: 20 }, ev => core.chatNotify(ev.params.jid, ev.params.mid, ev.data.data()));

// يلتقط ما فات المشغّلات (فشل مؤقت، مالك لم يسجّل بعد…)
exports.sweep = onSchedule({ schedule: 'every 5 minutes', region: SCHED_REGION, timeoutSeconds: 300 }, async () => {
  const cache = {};
  const q = await db.collection('notifs').where('pushed', '==', false).limit(30).get();
  for (const d of q.docs) {
    if (Date.now() - d.createTime.toMillis() < 3 * 60000) continue; // الحديثة يعالجها المشغّل الفوري
    const n = await core.claim(d.ref); if (!n) continue;
    try { await core.deliver(d.ref, n, cache); } catch (e) { logger.error('sweep deliver', d.id, e.message); }
  }
  const nu = await db.collection('users').where('ownerNotified', '==', false).limit(5).get();
  for (const d of nu.docs) await core.notifyNewUser(d.id, d.data()).catch(e => logger.error('sweep user', e.message));
  const inv = await db.collection('invites').where('status', '==', 'pending').limit(40).get();
  for (const d of inv.docs.filter(x => !x.data().ntf).slice(0, 5)) await core.notifyInvite(d.id, d.data(), d.createTime.toMillis()).catch(e => logger.error('sweep invite', e.message));
});

exports.reminders = onSchedule({ schedule: '0 8,12 * * *', timeZone: 'Asia/Riyadh', region: SCHED_REGION, timeoutSeconds: 300 }, async () => { await core.reminderJob(); });

// إشعارات يحدّدها المالك من لوحة الإدارة (settings/autoNotifs): يومية أو أسبوعية لجميع المستخدمين، تُفحص كل ساعة بتوقيت الرياض
exports.autoBroadcast = onSchedule({ schedule: '0 * * * *', timeZone: 'Asia/Riyadh', region: SCHED_REGION, timeoutSeconds: 300 }, async () => { await core.autoBroadcastJob(); });
