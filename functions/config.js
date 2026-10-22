'use strict';
// منطقة الدوال: يجب أن تطابق موقع قاعدة Firestore (Firebase ← Firestore ← Data ← الموقع في الأعلى أو Project settings ← Default GCP resource location)
//   nam5 → us-central1 | eur3 → europe-west1 | وإلا فاسم الموقع نفسه (مثل me-central2, europe-west1, us-east1)
const REGION = 'us-central1';
// منطقة المجدوِل (Cloud Scheduler) لا تدعم كل المناطق؛ إن فشل النشر بسببها غيّرها إلى europe-west1
const SCHED_REGION = REGION;
const OWNER_EMAIL = 'mamydady87@gmail.com'; // نفس بريد المالك في التطبيق
module.exports = { REGION, SCHED_REGION, OWNER_EMAIL };
