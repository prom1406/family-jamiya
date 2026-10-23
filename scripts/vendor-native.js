'use strict';
/* يجعل نسخة iOS تعمل دون أي مصدر خارجي للواجهة: Tailwind (مبني)، Font Awesome، خط Cairo، مكتبات Firebase وEmailJS.
   يُشغَّل بعد build-www.sh داخل www/ فقط (نسخة الويب تبقى كما هي). أي فشل يوقف البناء بدل أن ينتج تطبيقاً ناقصاً. */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..'), www = path.join(root, 'www'), v = path.join(www, 'vendor');
const nm = p => path.join(root, 'node_modules', p);
const mkdir = p => fs.mkdirSync(p, { recursive: true });
mkdir(v);

/* 1) Tailwind: نفس الإصدار 3 الذي كان يُحمَّل من CDN */
fs.writeFileSync(path.join(root, 'build', 'tw-in.css'), '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
cp.execFileSync(process.execPath, [nm('tailwindcss/lib/cli.js'), '-c', path.join(root, 'tailwind.config.js'), '-i', path.join(root, 'build', 'tw-in.css'), '-o', path.join(v, 'tailwind.css'), '--minify'], { stdio: 'inherit', cwd: root });

/* 2) Font Awesome 6 */
const fa = nm('@fortawesome/fontawesome-free');
mkdir(path.join(v, 'fa', 'css')); mkdir(path.join(v, 'fa', 'webfonts'));
fs.copyFileSync(path.join(fa, 'css', 'all.min.css'), path.join(v, 'fa', 'css', 'all.min.css'));
for (const f of fs.readdirSync(path.join(fa, 'webfonts'))) if (f.endsWith('.woff2')) fs.copyFileSync(path.join(fa, 'webfonts', f), path.join(v, 'fa', 'webfonts', f));

/* 3) خط Cairo: العربي واللاتيني فقط وبصيغة woff2 */
const cr = nm('@fontsource/cairo'); mkdir(path.join(v, 'cairo'));
let css = '';
for (const w of [300, 400, 600, 700, 900]) {
  const src = fs.readFileSync(path.join(cr, `${w}.css`), 'utf8');
  for (const block of src.match(/@font-face\s*\{[^}]*\}/g) || []) {
    const m = block.match(/url\(\.\/files\/([^)]+?-(arabic|latin|latin-ext)-\d+-normal\.woff2)\)/); if (!m) continue;
    fs.copyFileSync(path.join(cr, 'files', m[1]), path.join(v, 'cairo', m[1]));
    css += block.replace(/src:[^;]*;/, `src:url(./${m[1]}) format("woff2");`).replace(/font-display:\s*\w+;?/, 'font-display:swap;') + '\n';
  }
}
if (!/arabic/.test(css)) throw new Error('لم يُستخرج الخط العربي');
fs.writeFileSync(path.join(v, 'cairo', 'cairo.css'), css);

/* 4) EmailJS من npm، وFirebase (نفس إصدار الويب 11.10.0) من موقع Google */
fs.copyFileSync(nm('@emailjs/browser/dist/email.min.js'), path.join(v, 'email.min.js'));
(async () => {
  for (const n of ['app', 'auth', 'firestore', 'messaging', 'app-check']) {
    const r = await fetch(`https://www.gstatic.com/firebasejs/11.10.0/firebase-${n}-compat.js`);
    if (!r.ok) throw new Error('تعذر تنزيل firebase-' + n + ' ' + r.status);
    fs.writeFileSync(path.join(v, `firebase-${n}-compat.js`), Buffer.from(await r.arrayBuffer()));
  }
  /* 5) استبدال الروابط في www/index.html */
  const f = path.join(www, 'index.html'); let h = fs.readFileSync(f, 'utf8'); const before = h;
  const rep = (re, to) => { if (!re.test(h)) throw new Error('لم يُعثر على: ' + re); h = h.replace(re, to); };
  rep(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@emailjs\/browser@3\/dist\/email\.min\.js"><\/script>/, '<script src="vendor/email.min.js"></script>');
  rep(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/, '<link rel="stylesheet" href="vendor/tailwind.css">');
  rep(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Cairo[^"]*" rel="stylesheet">/, '<link rel="stylesheet" href="vendor/cairo/cairo.css">');
  rep(/<link rel="stylesheet" href="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/6\.4\.0\/css\/all\.min\.css">/, '<link rel="stylesheet" href="vendor/fa/css/all.min.css">');
  h = h.replace(/<script src="https:\/\/www\.gstatic\.com\/firebasejs\/10\.8\.0\/(firebase-[a-z-]+-compat\.js)"><\/script>/g, '<script src="vendor/$1"></script>');
  if (/cdn\.tailwindcss|fonts\.googleapis|cdnjs\.cloudflare|gstatic\.com\/firebasejs|cdn\.jsdelivr/.test(h)) throw new Error('بقي مصدر خارجي في www/index.html');
  fs.writeFileSync(f, h);
  console.log('vendor جاهز:', fs.readdirSync(v).join(', '), '| tailwind.css', fs.statSync(path.join(v, 'tailwind.css')).size, 'bytes');
})().catch(e => { console.error('✗', e.message); process.exit(1); });
