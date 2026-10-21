#!/usr/bin/env bash
# ينسخ ملفات الموقع إلى www/ ليحزمها Capacitor داخل تطبيق iOS.
# sw.js مستثنى عمداً: الـ Service Worker غير مدعوم داخل WKWebView.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf www
mkdir -p www

cp index.html privacy.html manifest.webmanifest \
   diyun.js i18n-en.js qattah.js wizard.js \
   favicon-32.png apple-touch-icon.png icon-192.png icon-512.png icon-maskable-512.png logo-full.jpg \
   www/

echo "www/ جاهز:"; ls www
