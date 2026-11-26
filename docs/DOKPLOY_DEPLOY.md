# دليل النشر على Dokploy

هذا الدليل يوضح كيفية نشر التطبيق (واجهة Telegram Web Z + لوحة الإدارة HeroUI على `/console/` + خادم MCP Streamable HTTP على `/mcp`) على خادم **Dokploy** الخاص بك، مع HTTPS تلقائي عبر Traefik المدمج في Dokploy وتخزين دائم مشفّر للجلسات.

---

## قبل البدء (المتطلبات)

1. خادم Dokploy يعمل ومحدّث، مع سجل DNS (`A` أو `AAAA`) يوجّه نطاقك (مثلاً `tg.example.com`) إلى عنوان IP للخادم.
2. بيانات تطبيق Telegram الخاصة بك (`TELEGRAM_API_ID` و `TELEGRAM_API_HASH`) من [my.telegram.org](https://my.telegram.org).
3. ثلاثة أسرار عشوائية قوية **منفصلة كلياً** (لا تكرر نفس القيمة ولا تضعها في Git):
   ```bash
   openssl rand -hex 32   # SESSION_ENCRYPTION_KEY
   openssl rand -hex 32   # ADMIN_AUTH_TOKEN
   openssl rand -hex 32   # MCP_AUTH_TOKEN
   ```

---

## الطريقة 1 (الموصى بها والأبسط): إنشاء Application عبر Dockerfile

1. في لوحة Dokploy افتح مشروعك ثم اضغط **Create Service → Application**.
2. من تبويب **General**:
   - **Provider:** اختر `GitHub` (أو `Git`) وحدد هذا المستودع والفرع (`master`).
   - **Build Type:** اختر **Dockerfile**.
   - **Dockerfile Path:** `Dockerfile`
   - **Docker Context Path:** `.`
3. من تبويب **Environment** أضف المتغيرات التالية (تُمرَّر تلقائياً لمرحلة البناء ومرحلة التشغيل):
   ```env
   NODE_ENV=production
   HOST=0.0.0.0
   PORT=8787
   DATA_DIR=/app/data
   TRUST_PROXY=true
   REQUIRE_HTTPS=true
   TELEGRAM_RUNTIME_MODE=gramjs
   TELEGRAM_API_ID=
   TELEGRAM_API_HASH=
   BASE_URL=https://tg.example.com/
   PUBLIC_ORIGIN=https://tg.example.com
   MCP_ALLOWED_ORIGINS=https://tg.example.com
   ACCOUNT_OWNER_ID=primary-owner
   SESSION_ENCRYPTION_KEY=
   ADMIN_AUTH_TOKEN=
   MCP_AUTH_TOKEN=
   ```
   *(استبدل `tg.example.com` بنطاقك الفعلي، واملأ القيم الفارغة داخل Dokploy Environment فقط).*
4. من تبويب **Advanced → Mounts** أضف تخزيناً دائماً لحفظ خزنة الجلسات المشفّرة عبر عمليات إعادة النشر:
   - **Type:** `Volume` *(مهم: استخدم Volume وليس Bind Mount مملوكاً لـ root حتى تحفظ الصلاحيات `node:node` و `0700` تلقائياً)*.
   - **Volume Name:** `telegram-web-z-vault`
   - **Mount Path:** `/app/data`
5. من تبويب **Domains** اضغط **Add Domain**:
   - **Host:** `tg.example.com`
   - **Container Port:** `8787`
   - **HTTPS:** `ON`
   - **Certificate:** `Let's Encrypt`
6. اضغط **Deploy** وانتظر اكتمال البناء وتحول حالة الحاوية إلى `Healthy`.

---

## الطريقة 2: إنشاء Compose Service عبر `docker-compose.dokploy.yml`

> **ملاحظة:** لا تستخدم `docker-compose.yml` العام داخل Dokploy لأنه يشغّل Caddy على المنفذين `80` و`443` وسيتعارض مع `dokploy-traefik`. استخدم [`docker-compose.dokploy.yml`](../docker-compose.dokploy.yml) المخصّص لـ Dokploy.

1. في Dokploy اضغط **Create Service → Compose**.
2. اختر **Compose Type:** `Docker Compose`.
3. اربط المستودع وحدد:
   - **Compose Path:** `./docker-compose.dokploy.yml`
4. من تبويب **Environment** أضف نفس المتغيرات المذكورة في الطريقة 1.
5. من تبويب **Domains** اضغط **Add Domain**:
   - **Service Name:** `app`
   - **Host:** `tg.example.com`
   - **Internal Port:** `8787`
   - **HTTPS:** `ON` و **Certificate:** `Let's Encrypt`
6. اضغط **Preview Compose** للتحقق من حقن شبكة `dokploy-network` ووسوم Traefik تلقائياً، ثم اضغط **Deploy**.
   *(عند أي تعديل على الدومين في Compose داخل Dokploy، يلزم الضغط على Redeploy لتطبيق الوسوم على الحاوية).*

---

## التحقق بعد النشر

1. **فحص الصحة:**
   ```bash
   curl -fsS https://tg.example.com/healthz
   ```
   يجب أن يعيد JSON فيه `"status":"ok"`.
2. **التحقق من رفض MCP غير المصادق عليه:**
   ```bash
   curl -i -X POST https://tg.example.com/mcp
   ```
   يجب أن يعيد `401 Unauthorized` مع `WWW-Authenticate: Bearer`.
3. **فتح الواجهات:**
   - واجهة Telegram Web Z (لتسجيل الدخول عبر GramJS WSS): `https://tg.example.com/`
   - لوحة الإدارة HeroUI العربية RTL: `https://tg.example.com/console/`
   - نقطة اتصال وكيل الذكاء الاصطناعي MCP Streamable HTTP: `https://tg.example.com/mcp`

---

## النسخ الاحتياطي والتحديث واستكشاف الأخطاء في Dokploy

- **التحديث:** اضغط **Redeploy** من Dokploy (أو فعّل Auto Deploy عبر GitHub Webhook). تبقى الجلسات المشفّرة محفوظة في المجلد الدائم `/app/data`.
- **النسخ الاحتياطي للخزنة المشفّرة:** يمكنك تنزيل الملف `/app/data/sessions.vault.enc.json` عبر Docker/SSH والاحتفاظ بمفتاح `SESSION_ENCRYPTION_KEY` في مدير أسرار منفصل.
- **في حال ظهور `404` أو `Bad Gateway`:**
  1. تأكد أن حالة الحاوية `Healthy` (لأن Traefik لا يوجّه الحركة للحاويات غير السليمة).
  2. راجع **Logs** في Dokploy؛ في الإنتاج يرفض الخادم البدء إذا كانت `SESSION_ENCRYPTION_KEY` أو `ADMIN_AUTH_TOKEN` أو `MCP_AUTH_TOKEN` فارغة أو أقل من 24 محرفاً أو متطابقة مع بعضها.
  3. في **Build Logs** تأكد أن `TELEGRAM_API_ID` و `TELEGRAM_API_HASH` معرّفان قبل البناء وإلا سيتوقف `vite build` برسالة `Missing required Telegram API credentials`.
  4. تأكد من تعطيل لوحة Traefik العامة (المنفذ `8080`) في إعدادات Dokploy للأمان.
