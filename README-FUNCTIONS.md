# إشعارات سِواء عبر Firebase Cloud Functions

بديل عن Cloudflare Worker. نفس المنطق، لكن الإرسال **فوري** (بعد 15 ثانية ليُسلّمه التطبيق المفتوح بنفسه) بدل الفحص كل دقيقة.

| الدالة | متى تعمل |
|---|---|
| `onNotifCreated` | عند إنشاء أي مستند في `notifs` ← يُرسل الإشعار لأجهزة المستلم (آيفون: إشعار ظاهر، متصفح: data) |
| `onUserCreated` | مشترك جديد ← إشعار للمالك |
| `onInviteCreated` | دعوة جديدة ← إشعار للمدعوّ إن كان له حساب |
| `sweep` | كل 5 دقائق: يلتقط ما فات (فشل مؤقت…) |
| `reminders` | الساعة 8 و12 بتوقيت الرياض: التذكيرات التلقائية |

## المتطلبات
- خطة **Blaze** مفعّلة على المشروع.
- في `functions/config.js` اجعل `REGION` مطابقاً لموقع قاعدة Firestore (nam5 ← us-central1، eur3 ← europe-west1، وإلا اسم الموقع نفسه).

## النشر (من المتصفح، بدون جهاز Mac) عبر Cloud Shell
1. افتح https://shell.cloud.google.com واختر المشروع `aljamiyahapp`.
2. نفّذ:
```bash
git clone https://github.com/prom1406/family-jamiya
cd family-jamiya/functions && npm install && cd ..
npx firebase-tools deploy --only functions --project aljamiyahapp
```
   - إن طلب تسجيل الدخول: `npx firebase-tools login --no-localhost` واتبع الرابط.
   - في أول نشر يطلب تفعيل واجهات (Cloud Build, Artifact Registry, Eventarc…): وافق.
   - إن سأل عن سياسة تنظيف الصور (cleanup policy) اكتب `1` (يوم).
3. بعد النجاح أوقف Cloudflare Worker (انظر أدناه) حتى لا تصل الإشعارات مرتين.

## إيقاف Cloudflare Worker
Cloudflare ← Workers & Pages ← الـ Worker ← Settings ← **Triggers** ← Cron Triggers ← احذف `* * * * *`.
(أبقِ الكود احتياطاً؛ لإعادته أضف الـ Cron من جديد.)

## واتساب الرسمي (اختياري)
إن كنت تستخدمه في الـ Worker، أنشئ `functions/.env` قبل النشر (الملف مستثنى من git):
```
WA_TOKEN=...
WA_PHONE_ID=...
WA_TEMPLATE=...
WA_LANG=ar
WA_KINDS=remind
```

## الاختبار والمتابعة
- اختبارات محلية بلا اتصال: `cd functions && npm test`
- السجلات: Firebase ← Functions ← Logs. ابحث عن `fcm failed` عند فشل إرسال.
- تشغيل التذكيرات يدوياً: Google Cloud ← Cloud Scheduler ← `firebase-schedule-reminders-...` ← Force run.
