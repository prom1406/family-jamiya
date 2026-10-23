// يُستعمل فقط عند بناء تطبيق iOS (scripts/vendor-native.js) لتوليد CSS محلي بدل Tailwind CDN
module.exports = { content: ['./www/index.html', './www/wizard.js', './www/qattah.js', './www/diyun.js', './www/i18n-en.js'], theme: { extend: {} }, plugins: [] };
