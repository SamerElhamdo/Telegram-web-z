# البنية المعمارية والأمان والاستضافة الذاتية (Telegram Web Z + لوحة الإدارة + MCP)

> **إشعار مهم:** هذا التطبيق **عميل غير رسمي** مبني على شيفرة [Telegram Web Z / Web A](https://github.com/TelegramOrg/Telegram-web-z.git) المفتوحة المصدر، ويتصل بخوادم Telegram عبر MTProto و WebSocket الآمن (WSS). لا يتبع هذا المشروع رسمياً لشركة Telegram، ولا يستخدم Telegram Bot API بديلاً عن جلسة المستخدم.

---

## 1. نظرة عامة على البنية ونقاط الربط

يعمل النظام كاملاً داخل نفس المستودع عبر ثلاث طبقات متكاملة:

1. **واجهة Telegram Web Z الأساسية (`src/`)**:
   - تحافظ على تجربة Telegram Web الأساسية المبنية على `Teact` وعميل `GramJS` داخل Web Worker.
   - طبقة النقل المدمجة: `src/lib/gramjs/Utils.ts` (`getDC`) و `src/lib/gramjs/extensions/PromisedWebSockets.ts` عبر نقاط اتصال Telegram Web الرسمية:
     `wss://zws{1..5}.web.telegram.org:443/apiws` (أو `/apiws_test` للخادم التجريبي).
   - تحسين مسار المصادقة في `src/lib/gramjs/client/auth.ts` و `src/components/auth/AuthCode.tsx` و `src/components/auth/AuthPhoneNumber.tsx`:
     - عرض نوع الاستجابة الدقيق من Telegram مثل `SentCodeTypeApp` أو `SentCodeTypeSms` أو `SentCodeTypeEmailCode` أو `SentCodeTypeSetUpEmailRequired`.
     - توضيح صريح بأن قبول `auth.sendCode` لا يثبت وصول الرمز فعلياً إلى الجهاز.
     - تقييد إعادة المحاولة عند `AUTH_RESTART` بمحاولة واحدة فقط وعدم طلب الرموز في حلقات تلقائية عند `FloodWait`.
   - رابط مباشر في القائمة الجانبية (`src/components/left/main/LeftSideMenuItems.tsx`) وعلى شاشة تسجيل الدخول لفتح لوحة الإدارة و MCP على `/console/`.

2. **لوحة الإدارة العربية RTL المبنية بـ HeroUI v3 (`console/`)**:
   - مبنية باستخدام React 19 و `@heroui/react` و `@heroui/styles` و Tailwind CSS v4 (تُبنى إلى `dist/console/` عبر `vite.console.config.ts`).
   - تدعم العربية RTL (`dir="rtl"`) والتجاوب والوضع الليلي وحالات التحميل والأخطاء.
   - تشمل ثلاث صفحات رئيسية:
     - **الحسابات والاتصال**: حالة WSS والمصادقة وطريقة الرمز، جسر ربط جلسة المتصفح بالخادم المشفّر، وفصل الحساب.
     - **المحادثات والموافقات**: عرض المحادثات وقراءة الرسائل والبحث فيها، الإرسال بعد نافذة تأكيد صريحة تعرض الحساب والمحادثة المستهدفين، وطابور موافقات وكيل الذكاء الاصطناعي (MCP).
     - **إعدادات MCP والأمان**: نقطة الاتصال `/mcp`، تدوير رمز Bearer، قائمة الأدوات الثماني، وسجل التدقيق المنقّح من الأسرار.

3. **الخادم الخلفي وخادم MCP (`server/`)**:
   - خادم Hono موحّد (`server/http/createApp.ts`) يخدم:
     - `/` ← واجهة Telegram Web Z
     - `/console/` ← لوحة الإدارة HeroUI
     - `/api/*` ← واجهة إدارة محمية بكوكي `HttpOnly; SameSite=Strict` موقّع + حماية CSRF
     - `/mcp` ← خادم **MCP عبر Streamable HTTP** باستخدام `@modelcontextprotocol/server` (يدعم مواصفتَي `2025-11-25` و `2026-07-28`)
     - `/healthz` و `/readyz` ← فحوص صحة وجاهزية الخدمة

---

## 2. صيغة جلسة Web Z وجسر نقل الجلسة ومخاطر مشاركة المفاتيح

### أين تُحفظ الجلسة في Telegram Web Z؟
- في المتصفح (`src/util/sessions.ts` و `src/util/multiaccount.ts` و `src/util/passcode/sessionStore.ts`):
  - لكل خانة حساب (`account1` .. `account6`) في `localStorage` (أو داخل الذاكرة المشفّرة عند تفعيل رمز قفل التطبيق): كائن JSON من نوع `SharedSessionData` يحتوي على `dcId` (من `1` إلى `5`) ومفاتيح MTProto الدائمة بصيغة Hex بطول 512 محرفاً (256 بايت) تحت المفاتيح `dc1_auth_key` .. `dc5_auth_key` بالإضافة إلى `authKeyCreatedAt` و `tempAuthKey` وبيانات تعريفية للحساب.
  - للخانة الأولى القديمة (Legacy): المفاتيح `user_auth` و `dc` و `dc{1..5}_auth_key`.
- داخل GramJS (`src/lib/gramjs/sessions/CallbackSession.ts`): تُحمّل بصيغة `ApiSessionData` (`{ mainDcId, keys: Record<number, string>, authKeyCreatedAt, tempAuthKey, isTest }`).

### كيف يعمل جسر الجلسة (`src/shared/sessionBridge.ts`)؟
1. لا يُنقل أي مفتاح تلقائياً في الخلفية؛ يعرض المتصفح في `/console/` البيانات الوصفية غير السرية فقط (الاسم، رقم الخانة، DC، الهاتف المقنّع).
2. عند ضغط المستخدم صراحةً على **«ربط الجلسة بالخادم المشفّر»** وبعد مراجعة تحذير المخاطر:
   - تُحوّل الجلسة عبر `buildBridgePayloadFromWebZSlot` وتُتحقّق بنيتها (رقم DC ضمن `1..5`، طول وصيغة كل مفتاح Hex بدقة 512 محرفاً).
   - تُرسل عبر HTTPS إلى `POST /api/accounts/import-session` (محمية بمصادقة الإدارة + CSRF + `Cache-Control: no-store`).
3. على الخادم (`server/storage/sessionVault.ts`):
   - تُشفّر الجلسة فوراً قبل كتابتها على القرص باستخدام **AES-256-GCM** مع IV عشوائي (12 بايت) ووسم مصادقة (AuthTag) و AAD مخصّص، ومفتاح مشتق من السر المنفصل `SESSION_ENCRYPTION_KEY`.
   - تُكتب الخزنة ذرياً (ملف مؤقت ثم `rename`) داخل مجلد بصلاحيات `0700` وملف بصلاحيات `0600` (`DATA_DIR/sessions.vault.enc.json`).
   - لا تُسجّل الجلسة أو مفاتيحها أو `TELEGRAM_API_HASH` أو رموز الدخول أو رموز Bearer في logs أو في ردود الواجهة.

### مخاطر مشاركة مفاتيح MTProto بين المتصفح والخلفية
- **تضاعف سطح الهجوم:** وجود نفس `auth_key` في المتصفح وعلى الخادم يعني أن اختراق أي طرف منهما (مثل XSS في المتصفح أو تسرب قرص الخادم مع مفتاح التشفير) يمنح وصولاً كاملاً للحساب.
- **تضارب حالة MTProto عند التزامن المكثف:** استخدام نفس `auth_key` بالتوازي في عميلين قد يؤدي أحياناً إلى تضارب في تسلسل الرسائل (`msg_seqno` / `salt`) أو إعادة اتصال مؤقتة؛ يُنصح بعدم تشغيل عمليات متزامنة كثيفة في الطرفين في اللحظة نفسها، أو فصل المتصفح محلياً بعد الربط إذا كان الاستخدام الرئيسي عبر الخادم/MCP.
- **عزل الأسرار:** يجب أن يكون `SESSION_ENCRYPTION_KEY` منفصلاً كلياً عن `TELEGRAM_API_HASH` و `ADMIN_AUTH_TOKEN` و `MCP_AUTH_TOKEN` (الخادم يرفض البدء في الإنتاج إذا تطابقت).
- **فصل الحساب مقابل إبطال الجلسة:** حذف الحساب من الخادم (`DELETE /api/accounts/:id`) أو مسح تخزين المتصفح يحذف النسخة المحلية فقط **ولا ينهي الجلسة على خوادم Telegram**. لإبطال الجلسة نهائياً يجب فتح **إعدادات Telegram ← الأجهزة (Settings → Devices)** وإنهاء الجلسة من هناك.

---

## 3. خادم MCP (Streamable HTTP) والأدوات والموافقات

- **نقطة الاتصال:** `https://<APP_DOMAIN>/mcp`
- **النقل:** Streamable HTTP عبر `@modelcontextprotocol/server` v2 (يدعم عملاء `2025-11-25` و `2026-07-28`، بدون الحاجة لجلسات sticky).
- **الأمان:**
  - يتطلب HTTPS في الإنتاج (`REQUIRE_HTTPS=true` خلف Reverse Proxy مع `X-Forwarded-Proto: https`).
  - مصادقة `Authorization: Bearer <MCP_AUTH_TOKEN>` مع مقارنة ثابتة الزمن (`timingSafeEqual`) وتخزين بصمة SHA-256 فقط، ودعم التدوير دون انقطاع (`MCP_AUTH_TOKEN_PREVIOUS` أو عبر صفحة إعدادات MCP).
  - التحقق من ترويسة `Origin` ضد `MCP_ALLOWED_ORIGINS` لمنع هجمات DNS Rebinding.
  - عزل كامل للحسابات بحيث لا يمكن لأي طلب غير مصرح به أو معرّف حساب غير مملوك قراءة بيانات أي حساب آخر.

### الأدوات المتاحة

| الأداة | النوع | تتطلب موافقة صريحة؟ | الوصف والتحقق |
| --- | --- | --- | --- |
| `list_accounts` | قراءة | لا | يعرض ملخص الحسابات المرتبطة فقط (بدون مفاتيح/أسرار). |
| `list_dialogs` | قراءة | لا | يعرض المحادثات (حد أقصى 100 محادثة). |
| `read_messages` | قراءة | لا | يقرأ رسائل `chatId` رقمي محدّد (حد أقصى 100 رسالة). |
| `search_messages` | قراءة | لا | يبحث نصياً (1–256 حرفاً، حد أقصى 50 نتيجة). |
| `send_message` | تغيير | **نعم** | ينشئ طلب موافقة مقيّد ببصمة المعاملات؛ لا يرسل حتى يوافق المستخدم صراحةً. |
| `create_group` | تغيير | **نعم** | ينشئ طلب موافقة يوضح الحساب والعنوان والأعضاء قبل التنفيذ. |
| `create_channel` | تغيير | **نعم** | ينشئ طلب موافقة يوضح الحساب والعنوان والوصف ونوع القناة. |
| `mark_chat_read` | تغيير | **نعم** | ينشئ طلب موافقة يوضح الحساب والمحادثة قبل التعليم كمقروء. |

---

## 4. التشغيل المحلي

1. انسخ ملف البيئة وأضف قيمك محلياً (لا ترفع `.env` إلى Git):
   ```bash
   cp .env.example .env
   ```
   ولّد أسراراً عشوائية قوية (32 بايت على الأقل لكل سر):
   ```bash
   openssl rand -hex 32
   ```
2. ثبّت التبعيات المثبّتة في `package-lock.json`:
   ```bash
   npm ci
   ```
3. للتجربة الآمنة دون اتصال حقيقي بـ Telegram، اضبط `TELEGRAM_RUNTIME_MODE=mock` في `.env`، أو `gramjs` لاستخدام `TELEGRAM_API_ID` و `TELEGRAM_API_HASH` الحقيقيين.
4. شغّل الخادم والواجهات محلياً:
   ```bash
   # الطرفية 1: الخادم الخلفي و MCP على http://127.0.0.1:8787
   npm run dev:server

   # الطرفية 2: لوحة الإدارة HeroUI على http://127.0.0.1:1235/console/
   npm run dev:console

   # الطرفية 3 (عند توفر TELEGRAM_API_ID/HASH): Telegram Web Z على http://localhost:1234
   npm run dev
   ```
5. للبناء الموحّد والتشغيل عبر منفذ واحد:
   ```bash
   npm run build:console
   npm run build:production
   npm run start:server
   ```

---

## 5. النشر على استضافة خاصة والتحديث والنسخ الاحتياطي

### النشر على Dokploy (جاهز مباشرة)
لنشر التطبيق على **Dokploy** عبر `Dockerfile` أو [`docker-compose.dokploy.yml`](../docker-compose.dokploy.yml) خلف Traefik المدمج مع Let's Encrypt وتخزين دائم `/app/data`، راجع الدليل المخصص خطوة بخطوة: [`docs/DOKPLOY_DEPLOY.md`](./DOKPLOY_DEPLOY.md).

### النشر المستقل عبر Docker Compose + Caddy HTTPS
1. على الخادم الخاص (VPS / سحابة خاصة تدعم Docker و Compose)، استنسخ المشروع وأنشئ `.env` من `.env.example` بالقيم الحقيقية (`APP_DOMAIN`, `ACME_EMAIL`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `BASE_URL`, `PUBLIC_ORIGIN`, `SESSION_ENCRYPTION_KEY`, `ADMIN_AUTH_TOKEN`, `MCP_AUTH_TOKEN`, `MCP_ALLOWED_ORIGINS`).
2. وجّه سجل DNS (`A` / `AAAA`) لنطاق `APP_DOMAIN` نحو الخادم، وتأكد من فتح المنفذين `80` و `443` فقط وإغلاق منفذ `8787` عن الإنترنت العام.
3. شغّل الخدمة:
   ```bash
   docker compose up -d --build
   ```
4. تحقق من الصحة:
   ```bash
   curl -fsS https://<APP_DOMAIN>/healthz
   ```

### التحديث
```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
```

### النسخ الاحتياطي والاستعادة
- تحفظ الخزنة المشفّرة في المجلد `DATA_DIR/sessions.vault.enc.json` (داخل Docker volume باسم `vault_data`).
- **النسخ الاحتياطي:**
  ```bash
  docker compose exec -T app cat /app/data/sessions.vault.enc.json > backup-vault-$(date +%Y%m%d).enc.json
  chmod 600 backup-vault-*.enc.json
  ```
  احتفظ بمفتاح `SESSION_ENCRYPTION_KEY` في مدير أسرار منفصل عن ملف النسخة الاحتياطية؛ بدون هذا المفتاح لا يمكن فك تشفير النسخة الاحتياطية.
- **الاستعادة:**
  ```bash
  docker compose stop app
  docker compose run --rm -T app sh -c 'umask 077 && cat > /app/data/sessions.vault.enc.json' < backup-vault-YYYYMMDD.enc.json
  docker compose start app
  ```

### CI/CD عبر GitHub Actions
الملف `.github/workflows/ci-deploy.yml` يتحقق تلقائياً من TypeScript و ESLint و Stylelint واختبارات المحاكاة وبناء HeroUI Console. ولنشر صورة حاوية اختيارياً عبر `workflow_dispatch`، تُضبط الأسرار التالية في إعدادات GitHub Secrets فقط:
`CONTAINER_REGISTRY`, `CONTAINER_REGISTRY_USER`, `CONTAINER_REGISTRY_TOKEN`, `CONTAINER_IMAGE_NAME`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `BASE_URL`.

---

## 6. الترخيص والتوافق مع GNU GPL-3.0-or-later

- المشروع الأصلي مرخّص بموجب **GNU General Public License v3.0 or later (`GPL-3.0-or-later`)**؛ انظر ملف [`LICENSE`](../LICENSE).
- وفقاً لقسم 5 من رخصة GPLv3 وإجابات [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html):
  - يجب الإبقاء على ملف `LICENSE` وإشعارات حقوق النشر والتراخيص الأصلية دون إزالة.
  - يجب وضع إشعار واضح بأن النسخة معدّلة وتاريخ التعديل (مضاف في `README.md` وملفات التوثيق).
  - عند توزيع النسخة المعدّلة (Conveying)، يجب أن تُرخّص النسخة الكاملة بموجب **GPL-3.0-or-later** وتُتاح الشيفرة المصدرية المقابلة (Corresponding Source).
  - التشغيل الخاص على خادم شخصي دون توزيع نسخ للآخرين مسموح به، لكن نشر واجهة JavaScript للعموم في المتصفح يُعدّ توزيعاً لشيفرة العميل ويتطلب إتاحة الشيفرة المصدرية المقابلة بموجب GPLv3.

### مراجعة تراخيص التبعيات المضافة

| الحزمة | الإصدار المثبّت | الترخيص | التوافق مع GPL-3.0-or-later |
| --- | --- | --- | --- |
| `@modelcontextprotocol/server` | `2.4.0` | Apache-2.0 | متوافق مع GPLv3 |
| `@modelcontextprotocol/node` | `2.1.2` | Apache-2.0 | متوافق مع GPLv3 |
| `zod` | `4.6.7` | MIT | متوافق مع GPLv3 |
| `react` / `react-dom` | `19.3.0` | MIT | متوافق مع GPLv3 |
| `@heroui/react` | `3.2.8` | Apache-2.0 | متوافق مع GPLv3 |
| `@heroui/styles` | `3.2.8` | Apache-2.0 | متوافق مع GPLv3 |
| `tailwindcss` / `@tailwindcss/vite` | `4.3.5` | MIT | متوافق مع GPLv3 |
| `@vitejs/plugin-react` | `6.3.0` | MIT | متوافق مع GPLv3 |
| `@types/react-dom` | `19.3.0` | MIT | متوافق مع GPLv3 |

*(ملاحظة قانونية: رخصة Apache 2.0 متوافقة مع GPLv3 وفقاً لإرشادات مؤسسة البرمجيات الحرة FSF GPL FAQ، وليست متوافقة مع GPLv2 فقط؛ وبما أن هذا المشروع مرخص تحت `GPL-3.0-or-later` فإن الدمج متوافق عند التوزيع تحت GPLv3.)*
