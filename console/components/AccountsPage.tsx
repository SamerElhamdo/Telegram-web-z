import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Chip,
  Input,
  Label,
  Modal,
  Separator,
  Spinner,
  Switch,
} from '@heroui/react';

import type { AccountStatus, PublicAccountSummary } from '../lib/api';
import type { BrowserAuthDiagnostics, BrowserSlotSummary } from '../lib/browserBridge';

import { consoleApi } from '../lib/api';
import {
  buildLocalSlotBridgePayload,
  clearLocalWebZSlot,
  detectLocalWebZSlots,
  readBrowserAuthDiagnostics,
} from '../lib/browserBridge';

type AccountsPageProps = {
  accounts: PublicAccountSummary[];
  runtimeMode: 'gramjs' | 'mock';
  isLoading: boolean;
  onRefreshAccounts: () => Promise<void>;
};

export function AccountsPage({
  accounts,
  runtimeMode,
  isLoading,
  onRefreshAccounts,
}: AccountsPageProps) {
  const [browserSlots, setBrowserSlots] = useState<BrowserSlotSummary[]>([]);
  const [diagnostics, setDiagnostics] = useState<BrowserAuthDiagnostics | undefined>();
  const [statusByAccount, setStatusByAccount] = useState<Record<string, AccountStatus>>({});
  const [checkingId, setCheckingId] = useState<string | undefined>();
  const [feedback, setFeedback] = useState<{ status: 'success' | 'danger' | 'warning'; title: string; text: string } | undefined>();

  // Link modal state
  const [slotToLink, setSlotToLink] = useState<BrowserSlotSummary | undefined>();
  const [customLabel, setCustomLabel] = useState('');
  const [isLinking, setIsLinking] = useState(false);

  // Disconnect modal state
  const [accountToDisconnect, setAccountToDisconnect] = useState<PublicAccountSummary | undefined>();
  const [shouldAlsoClearBrowserSlot, setShouldAlsoClearBrowserSlot] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  function refreshBrowserInfo() {
    setBrowserSlots(detectLocalWebZSlots());
    setDiagnostics(readBrowserAuthDiagnostics());
  }

  useEffect(() => {
    refreshBrowserInfo();
  }, []);

  async function handleCheckStatus(accountId: string) {
    setCheckingId(accountId);
    setFeedback(undefined);
    try {
      const { status } = await consoleApi.getAccountStatus(accountId);
      setStatusByAccount((prev) => ({ ...prev, [accountId]: status }));
    } catch (err: unknown) {
      setFeedback({
        status: 'danger',
        title: 'تعذر فحص حالة الاتصال',
        text: err instanceof Error ? err.message : 'خطأ غير متوقع',
      });
    } finally {
      setCheckingId(undefined);
    }
  }

  async function handleConfirmLinkSlot() {
    if (!slotToLink || isLinking) return;
    setIsLinking(true);
    setFeedback(undefined);
    try {
      const payload = buildLocalSlotBridgePayload(slotToLink.slot);
      const res = await consoleApi.importSession(payload, customLabel.trim() || slotToLink.displayName);
      setSlotToLink(undefined);
      setCustomLabel('');
      await onRefreshAccounts();
      setFeedback({
        status: 'success',
        title: 'تم ربط الجلسة وتشفيرها بنجاح',
        text: res.notice,
      });
    } catch (err: unknown) {
      setFeedback({
        status: 'danger',
        title: 'فشل ربط الجلسة',
        text: err instanceof Error ? err.message : 'تعذر تحويل أو تشفير الجلسة',
      });
    } finally {
      setIsLinking(false);
    }
  }

  async function handleConfirmDisconnect() {
    if (!accountToDisconnect || isDisconnecting) return;
    setIsDisconnecting(true);
    setFeedback(undefined);
    try {
      const res = await consoleApi.deleteAccount(accountToDisconnect.id);
      if (shouldAlsoClearBrowserSlot && accountToDisconnect.slot) {
        clearLocalWebZSlot(accountToDisconnect.slot);
        refreshBrowserInfo();
      }
      setAccountToDisconnect(undefined);
      setShouldAlsoClearBrowserSlot(false);
      await onRefreshAccounts();
      setFeedback({
        status: 'warning',
        title: 'تم فصل الحساب وحذف البيانات المحلية',
        text: res.revocationNotice,
      });
    } catch (err: unknown) {
      setFeedback({
        status: 'danger',
        title: 'فشل فصل الحساب',
        text: err instanceof Error ? err.message : 'خطأ غير متوقع',
      });
    } finally {
      setIsDisconnecting(false);
    }
  }

  const remainingFloodSec = diagnostics?.floodWaitUntil
    ? Math.max(0, Math.ceil((diagnostics.floodWaitUntil - Date.now()) / 1000))
    : 0;

  return (
    <div className="space-y-6">
      {feedback && (
        <Alert status={feedback.status}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{feedback.title}</Alert.Title>
            <Alert.Description>{feedback.text}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {/* WSS & Auth Diagnostics Card */}
      <Card className="p-2">
        <Card.Header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <Card.Title>حالة اتصال WSS والمصادقة (GramJS MTProto)</Card.Title>
            <Card.Description>
              يستخدم التطبيق مسار GramJS المدمج في Telegram Web Z عبر WebSocket الآمن (WSS) بدون Telethon أو اتصال TCP مباشر.
            </Card.Description>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Chip color={runtimeMode === 'mock' ? 'warning' : 'success'} variant="soft" size="sm">
              <Chip.Label>{runtimeMode === 'mock' ? 'وضع المحاكاة (Mock)' : 'وضع GramJS WSS'}</Chip.Label>
            </Chip>
            <Button variant="secondary" size="sm" onPress={refreshBrowserInfo}>
              تحديث القراءة المحلية
            </Button>
            <a
              href="/"
              className="inline-flex items-center justify-center rounded-full bg-accent text-accent-foreground px-4 py-1.5 text-sm font-medium hover:opacity-90"
            >
              فتح Telegram Web Z لتسجيل الدخول
            </a>
          </div>
        </Card.Header>

        <Card.Content className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-xl border border-border p-3 space-y-1">
              <div className="text-xs text-muted">حالة اتصال WSS في المتصفح</div>
              <div className="font-semibold text-sm">
                {formatConnectionState(diagnostics?.connectionState)}
              </div>
              <div className="text-xs text-muted ltr-inline">
                wss://zws&#123;1..5&#125;.web.telegram.org:443/apiws
              </div>
            </div>

            <div className="rounded-xl border border-border p-3 space-y-1">
              <div className="text-xs text-muted">حالة المصادقة الحالية</div>
              <div className="font-semibold text-sm">
                {formatAuthState(diagnostics?.authState)}
              </div>
              {diagnostics?.errorCode && (
                <div className="text-xs text-danger ltr-inline">
                  آخر رمز خطأ: {diagnostics.errorCode}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border p-3 space-y-1">
              <div className="text-xs text-muted">طريقة الرمز التي أبلغ بها Telegram</div>
              <div className="font-semibold text-sm ltr-inline">
                {diagnostics?.sentCodeInfo?.type || 'لا يوجد طلب رمز نشط'}
              </div>
              {diagnostics?.sentCodeInfo?.emailPattern && (
                <div className="text-xs text-muted ltr-inline">
                  البريد: {diagnostics.sentCodeInfo.emailPattern}
                </div>
              )}
            </div>
          </div>

          <Alert status="accent">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>توضيح هام حول auth.sendCode</Alert.Title>
              <Alert.Description>
                قبول خوادم Telegram لطلب <code className="ltr-inline">auth.sendCode</code> وإرجاع نوع مثل{' '}
                <code className="ltr-inline">SentCodeTypeApp</code> أو <code className="ltr-inline">SentCodeTypeSms</code>{' '}
                لا يثبت وصول الرمز فعلياً إلى جهازك. كما يمنع التطبيق إعادة طلب الرمز تلقائياً في حلقات عند قيود FloodWait.
              </Alert.Description>
            </Alert.Content>
          </Alert>

          {remainingFloodSec > 0 && (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>قيد FloodWait نشط</Alert.Title>
                <Alert.Description>
                  يرجى الانتظار {remainingFloodSec} ثانية قبل إعادة المحاولة من واجهة Telegram Web Z.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          )}
        </Card.Content>
      </Card>

      {/* Browser Session Bridge */}
      <Card className="p-2">
        <Card.Header>
          <Card.Title>جسر جلسة المتصفح (Web Z ← الخادم المشفّر)</Card.Title>
          <Card.Description>
            تُقرأ هنا البيانات الوصفية فقط لجلسات المتصفح الموجودة في نفس النطاق (بدون عرض أي مفاتيح أو أسرار). عند الربط، تُرسل الجلسة لمرة واحدة وتُشفّر على الخادم بمفتاح منفصل (AES-256-GCM).
          </Card.Description>
        </Card.Header>

        <Card.Content className="space-y-3">
          {browserSlots.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted">
              لم يتم اكتشاف جلسة Telegram Web Z مخزّنة في هذا المتصفح حالياً. افتح{' '}
              <a href="/" className="text-accent underline">Telegram Web Z</a>{' '}
              وسجّل الدخول عبر GramJS WSS ثم ارجع هنا لربط الجلسة بالخادم و MCP.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {browserSlots.map((slot) => (
                <div
                  key={slot.slot}
                  className="rounded-xl border border-border p-4 flex flex-col justify-between gap-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{slot.displayName}</span>
                      <Chip color={slot.hasMainDcKey ? 'success' : 'warning'} variant="soft" size="sm">
                        <Chip.Label>الخانة #{slot.slot} • DC {slot.mainDcId}</Chip.Label>
                      </Chip>
                    </div>
                    <div className="text-xs text-muted ltr-inline">{slot.wssEndpoint}</div>
                    {slot.phoneMasked && (
                      <div className="text-xs text-muted">الهاتف: <span className="ltr-inline">{slot.phoneMasked}</span></div>
                    )}
                    <div className="text-xs text-muted">
                      حالة المفتاح المحلي: {slot.hasMainDcKey ? 'موجود (مخفي للأمان)' : 'غير مكتمل'}
                    </div>
                  </div>

                  <Button
                    variant="primary"
                    size="sm"
                    isDisabled={!slot.hasMainDcKey}
                    onPress={() => {
                      setSlotToLink(slot);
                      setCustomLabel(slot.displayName);
                    }}
                  >
                    ربط الجلسة بالخادم المشفّر و MCP
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card.Content>
      </Card>

      {/* Linked Server Accounts */}
      <Card className="p-2">
        <Card.Header className="flex flex-row items-center justify-between gap-2 flex-wrap">
          <div>
            <Card.Title>الحسابات المرتبطة على الخادم ({accounts.length})</Card.Title>
            <Card.Description>
              مخزّنة داخل الخزنة المشفّرة على الخادم بصلاحيات ملفات مقيدة (0600)، ولا تُعرض مفاتيحها في الواجهة أو السجلات.
            </Card.Description>
          </div>
          <Button variant="secondary" size="sm" onPress={() => void onRefreshAccounts()}>
            تحديث القائمة
          </Button>
        </Card.Header>

        <Card.Content>
          {isLoading ? (
            <div className="py-8 flex items-center justify-center gap-2 text-muted">
              <Spinner size="sm" />
              <span>جارٍ تحميل الحسابات...</span>
            </div>
          ) : accounts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">
              لا توجد حسابات مرتبطة على الخادم بعد. اربط جلسة من القسم أعلاه للبدء.
            </div>
          ) : (
            <div className="space-y-3">
              {accounts.map((account) => {
                const status = statusByAccount[account.id];
                return (
                  <div
                    key={account.id}
                    className="rounded-xl border border-border p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4"
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-base">{account.label}</span>
                        <Chip color="default" variant="soft" size="sm">
                          <Chip.Label className="ltr-inline">{account.id}</Chip.Label>
                        </Chip>
                        <Chip color="accent" variant="soft" size="sm">
                          <Chip.Label>DC {account.mainDcId}</Chip.Label>
                        </Chip>
                        {account.isTest && (
                          <Chip color="warning" variant="soft" size="sm">
                            <Chip.Label>خادم تجريبي</Chip.Label>
                          </Chip>
                        )}
                      </div>

                      <div className="text-xs text-muted ltr-inline">{account.wssEndpoint}</div>
                      <div className="text-xs text-muted flex flex-wrap gap-x-4 gap-y-1">
                        {account.profile.userId && <span>معرّف المستخدم: <strong className="ltr-inline">{account.profile.userId}</strong></span>}
                        {account.profile.phoneMasked && <span>الهاتف: <strong className="ltr-inline">{account.profile.phoneMasked}</strong></span>}
                        <span>تاريخ الربط: {new Date(account.linkedAt).toLocaleString('ar')}</span>
                      </div>

                      {status && (
                        <div className="pt-1 flex items-center gap-2 flex-wrap text-xs">
                          <Chip color={status.connected && status.authorized ? 'success' : 'danger'} variant="soft" size="sm">
                            <Chip.Label>
                              {status.connected && status.authorized ? 'متصل ومصرّح عبر WSS' : 'غير متصل / غير مصرّح'}
                            </Chip.Label>
                          </Chip>
                          {status.error && <span className="text-danger">{status.error}</span>}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        variant="secondary"
                        size="sm"
                        isDisabled={checkingId === account.id}
                        onPress={() => void handleCheckStatus(account.id)}
                      >
                        {checkingId === account.id ? 'جارٍ الفحص...' : 'فحص اتصال WSS'}
                      </Button>
                      <Button
                        variant="danger-soft"
                        size="sm"
                        onPress={() => {
                          setAccountToDisconnect(account);
                          setShouldAlsoClearBrowserSlot(false);
                        }}
                      >
                        فصل الحساب وحذف البيانات المحلية
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card.Content>
      </Card>

      {/* Link Session Confirmation & Risk Disclosure Modal */}
      <Modal isOpen={Boolean(slotToLink)} onOpenChange={(open) => { if (!open) setSlotToLink(undefined); }}>
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>تأكيد ربط جلسة المتصفح بالخادم المشفّر</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="space-y-4">
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>مخاطر مشاركة مفاتيح الجلسة بين المتصفح والخلفية</Alert.Title>
                    <Alert.Description>
                      نسخ مفتاح MTProto من المتصفح إلى الخادم يعني أن كلا الطرفين يحملان نفس صلاحية الوصول للحساب.
                      احرص على تشغيل الاستضافة خلف HTTPS فقط، وحماية مفاتيح التشفير، وتجنب التشغيل المتزامن المكثف على نفس المفتاح.
                    </Alert.Description>
                  </Alert.Content>
                </Alert>

                {slotToLink && (
                  <div className="rounded-lg border border-border p-3 text-sm space-y-1">
                    <div>الحساب المصدر: <strong>{slotToLink.displayName}</strong> (الخانة #{slotToLink.slot})</div>
                    <div>مركز البيانات: <strong>DC {slotToLink.mainDcId}</strong></div>
                    <div className="text-xs text-muted ltr-inline">{slotToLink.wssEndpoint}</div>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="account-label-input">اسم تعريفي للحساب في لوحة الإدارة و MCP</Label>
                  <Input
                    id="account-label-input"
                    value={customLabel}
                    onChange={(e) => setCustomLabel(e.target.value)}
                    placeholder="مثال: حسابي الشخصي"
                    fullWidth
                  />
                </div>
              </Modal.Body>
              <Modal.Footer className="flex gap-2 justify-end">
                <Button variant="secondary" onPress={() => setSlotToLink(undefined)} isDisabled={isLinking}>
                  إلغاء
                </Button>
                <Button variant="primary" onPress={() => void handleConfirmLinkSlot()} isDisabled={isLinking}>
                  {isLinking ? 'جارٍ التشفير والحفظ...' : 'أوافق، اربط الجلسة وشفّرها'}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      {/* Disconnect Account Confirmation Modal */}
      <Modal
        isOpen={Boolean(accountToDisconnect)}
        onOpenChange={(open) => { if (!open) setAccountToDisconnect(undefined); }}
      >
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>فصل الحساب وحذف النسخة المحلية</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="space-y-4">
                {accountToDisconnect && (
                  <div className="rounded-lg border border-border p-3 text-sm space-y-1">
                    <div>الحساب المستهدف: <strong>{accountToDisconnect.label}</strong></div>
                    <div className="text-xs text-muted ltr-inline">{accountToDisconnect.id}</div>
                  </div>
                )}

                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>تنبيه مهم حول إبطال الجلسة</Alert.Title>
                    <Alert.Description>
                      حذف النسخة المحلية أو نسخة الخادم المشفّرة <strong>لا ينهي الجلسة على خوادم Telegram</strong>.
                      لإبطال الجلسة نهائياً، افتح تطبيق Telegram ثم انتقل إلى: <strong>الإعدادات ← الأجهزة (Settings → Devices)</strong> وأنهِ الجلسة من هناك.
                    </Alert.Description>
                  </Alert.Content>
                </Alert>

                {accountToDisconnect?.slot && (
                  <>
                    <Separator />
                    <Switch
                      isSelected={shouldAlsoClearBrowserSlot}
                      onChange={setShouldAlsoClearBrowserSlot}
                    >
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <Switch.Content>
                        <Label className="text-sm">حذف بيانات الخانة #{accountToDisconnect.slot} من تخزين المتصفح المحلي أيضاً</Label>
                      </Switch.Content>
                    </Switch>
                  </>
                )}
              </Modal.Body>
              <Modal.Footer className="flex gap-2 justify-end">
                <Button variant="secondary" onPress={() => setAccountToDisconnect(undefined)} isDisabled={isDisconnecting}>
                  إلغاء
                </Button>
                <Button variant="danger" onPress={() => void handleConfirmDisconnect()} isDisabled={isDisconnecting}>
                  {isDisconnecting ? 'جارٍ الحذف...' : 'تأكيد الفصل والحذف المحلي'}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

function formatConnectionState(state?: string): string {
  switch (state) {
    case 'connectionStateReady':
      return 'متصل (WSS جاهز)';
    case 'connectionStateConnecting':
      return 'جارٍ الاتصال عبر WSS...';
    case 'connectionStateBroken':
      return 'انقطع الاتصال';
    default:
      return 'غير مرصود بعد (افتح Telegram Web Z)';
  }
}

function formatAuthState(state?: string): string {
  switch (state) {
    case 'authorizationStateReady':
      return 'مسجّل الدخول بنجاح';
    case 'authorizationStateWaitPhoneNumber':
      return 'بانتظار رقم الهاتف';
    case 'authorizationStateWaitCode':
      return 'بانتظار رمز الدخول';
    case 'authorizationStateWaitPassword':
      return 'بانتظار كلمة مرور التحقق بخطوتين (2FA)';
    case 'authorizationStateWaitQrCode':
      return 'بانتظار مسح رمز QR';
    default:
      return 'غير محددة';
  }
}
