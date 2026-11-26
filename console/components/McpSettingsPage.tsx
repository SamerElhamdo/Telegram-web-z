import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Chip,
  Label,
  Separator,
  Spinner,
  Switch,
} from '@heroui/react';

import type { AuditLogEntry, McpSettingsResponse } from '../lib/api';

import { consoleApi } from '../lib/api';

export function McpSettingsPage() {
  const [settings, setSettings] = useState<McpSettingsResponse | undefined>();
  const [auditEntries, setAuditEntries] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const [keepPrevious, setKeepPrevious] = useState(true);
  const [isRotating, setIsRotating] = useState(false);
  const [rotatedTokenResult, setRotatedTokenResult] = useState<{
    newToken: string;
    rotatedAt: number;
    warning: string;
  } | undefined>();
  const [isCopied, setIsCopied] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const [settingsRes, auditRes] = await Promise.all([
        consoleApi.getMcpSettings(),
        consoleApi.getAuditLog(30),
      ]);
      setSettings(settingsRes);
      setAuditEntries(auditRes.entries);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل إعدادات MCP');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function handleRotateToken() {
    if (isRotating) return;
    setIsRotating(true);
    setError(undefined);
    try {
      const res = await consoleApi.rotateMcpToken(keepPrevious);
      setRotatedTokenResult({
        newToken: res.newToken,
        rotatedAt: res.rotatedAt,
        warning: res.warning,
      });
      setIsCopied(false);
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'فشل تدوير رمز MCP');
    } finally {
      setIsRotating(false);
    }
  }

  async function handleCopyRotatedToken() {
    if (!rotatedTokenResult) return;
    try {
      await navigator.clipboard.writeText(rotatedTokenResult.newToken);
      setIsCopied(true);
    } catch {
      setIsCopied(false);
    }
  }

  if (isLoading && !settings) {
    return (
      <div className="py-12 flex items-center justify-center gap-2 text-muted">
        <Spinner size="sm" />
        <span>جارٍ تحميل إعدادات خادم MCP...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>خطأ في إعدادات MCP</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {settings && (
        <Card className="p-2">
          <Card.Header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <Card.Title>إعدادات خادم MCP (Streamable HTTP)</Card.Title>
              <Card.Description>
                خادم MCP يعمل خلف Reverse Proxy مع HTTPS، ومصادقة Bearer قوية قابلة للتدوير، والتحقق من Origin لمنع هجمات DNS Rebinding.
              </Card.Description>
            </div>
            <Button variant="secondary" size="sm" onPress={() => void loadData()}>
              تحديث
            </Button>
          </Card.Header>

          <Card.Content className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-xl border border-border p-3 space-y-1">
                <div className="text-xs text-muted">عنوان نقطة اتصال MCP</div>
                <div className="font-mono text-sm break-all ltr-inline">{settings.endpointUrl}</div>
              </div>
              <div className="rounded-xl border border-border p-3 space-y-1">
                <div className="text-xs text-muted">طبقة النقل والبروتوكول</div>
                <div className="text-sm font-medium ltr-inline">{settings.transport}</div>
              </div>
              <div className="rounded-xl border border-border p-3 space-y-1">
                <div className="text-xs text-muted">المصادقة</div>
                <div className="text-sm font-medium">{settings.authScheme}</div>
              </div>
              <div className="rounded-xl border border-border p-3 space-y-1">
                <div className="text-xs text-muted">فرض HTTPS ووضع التشغيل</div>
                <div className="flex items-center gap-2 flex-wrap pt-0.5">
                  <Chip color={settings.httpsEnforced ? 'success' : 'warning'} variant="soft" size="sm">
                    <Chip.Label>{settings.httpsEnforced ? 'HTTPS إجباري' : 'تطوير محلي (HTTP)'}</Chip.Label>
                  </Chip>
                  <Chip color={settings.runtimeMode === 'mock' ? 'warning' : 'accent'} variant="soft" size="sm">
                    <Chip.Label>{settings.runtimeMode === 'mock' ? 'وضع المحاكاة' : 'GramJS WSS'}</Chip.Label>
                  </Chip>
                </div>
              </div>
            </div>

            <Separator />

            {/* Bearer Token Rotation */}
            <div className="space-y-3">
              <div className="font-semibold text-sm">تدوير رمز Bearer لوكيل الذكاء الاصطناعي</div>
              <p className="text-xs text-muted">
                لا يُخزّن رمز MCP بنص صريح على الخادم (تُحفظ بصمة SHA-256 فقط). يمكنك تدويره دون انقطاع بإبقاء الرمز السابق صالحاً مؤقتاً أو إبطاله فوراً.
              </p>

              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <Switch isSelected={keepPrevious} onChange={setKeepPrevious}>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Switch.Content>
                    <Label className="text-sm">إبقاء الرمز السابق فعالاً لفترة انتقال (تدوير دون انقطاع)</Label>
                  </Switch.Content>
                </Switch>

                <Button
                  variant="primary"
                  size="sm"
                  isDisabled={isRotating}
                  onPress={() => void handleRotateToken()}
                >
                  {isRotating ? 'جارٍ التوليد...' : 'توليد وتدوير رمز Bearer جديد'}
                </Button>
              </div>

              {rotatedTokenResult && (
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content className="space-y-2 w-full">
                    <Alert.Title>رمز Bearer الجديد (يُعرض مرة واحدة فقط)</Alert.Title>
                    <Alert.Description>{rotatedTokenResult.warning}</Alert.Description>
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="rounded-lg bg-background border border-border px-3 py-1.5 text-xs break-all ltr-inline">
                        {rotatedTokenResult.newToken}
                      </code>
                      <Button variant="secondary" size="sm" onPress={() => void handleCopyRotatedToken()}>
                        {isCopied ? 'تم النسخ' : 'نسخ الرمز'}
                      </Button>
                      <Button variant="ghost" size="sm" onPress={() => setRotatedTokenResult(undefined)}>
                        إخفاء الآن
                      </Button>
                    </div>
                  </Alert.Content>
                </Alert>
              )}
            </div>
          </Card.Content>
        </Card>
      )}

      {/* MCP Tool Catalog */}
      {settings && (
        <Card className="p-2">
          <Card.Header>
            <Card.Title>أدوات MCP المتاحة ({settings.tools.length})</Card.Title>
            <Card.Description>
              أدوات القراءة مقيدة بالحسابات المصرح بها فقط، بينما جميع أدوات التغيير تتطلب موافقة صريحة من المستخدم قبل أي تنفيذ.
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {settings.tools.map((tool) => (
                <div key={tool.name} className="rounded-xl border border-border p-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <code className="font-semibold text-sm ltr-inline">{tool.name}</code>
                    <div className="flex items-center gap-1.5">
                      <Chip
                        color={tool.category === 'read' ? 'accent' : 'warning'}
                        variant="soft"
                        size="sm"
                      >
                        <Chip.Label>{tool.category === 'read' ? 'قراءة' : 'تغيير'}</Chip.Label>
                      </Chip>
                      {tool.requiresApproval && (
                        <Chip color="danger" variant="soft" size="sm">
                          <Chip.Label>موافقة صريحة</Chip.Label>
                        </Chip>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-muted">{tool.description}</p>
                </div>
              ))}
            </div>
          </Card.Content>
        </Card>
      )}

      {/* Redacted Audit Log */}
      <Card className="p-2">
        <Card.Header>
          <Card.Title>سجل التدقيق الأمني (منقّح من الأسرار)</Card.Title>
          <Card.Description>
            يُسجّل العمليات الإدارية واستدعاءات MCP دون تسجيل مفاتيح الجلسة أو API Hash أو رموز الدخول.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {auditEntries.length === 0 ? (
            <div className="text-sm text-muted text-center py-4">لا توجد أحداث مسجّلة بعد.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-start border-collapse">
                <thead>
                  <tr className="border-b border-border text-muted">
                    <th className="py-2 px-2 text-start">الوقت</th>
                    <th className="py-2 px-2 text-start">المصدر</th>
                    <th className="py-2 px-2 text-start">الإجراء</th>
                    <th className="py-2 px-2 text-start">الحالة</th>
                    <th className="py-2 px-2 text-start">تفاصيل</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map((entry) => (
                    <tr key={entry.id} className="border-b border-border/50">
                      <td className="py-2 px-2 whitespace-nowrap">{new Date(entry.timestamp).toLocaleString('ar')}</td>
                      <td className="py-2 px-2">{entry.actor}</td>
                      <td className="py-2 px-2 font-mono ltr-inline">{entry.action}</td>
                      <td className="py-2 px-2">
                        <Chip
                          size="sm"
                          variant="soft"
                          color={
                            entry.status === 'ok'
                              ? 'success'
                              : entry.status === 'pending_approval'
                                ? 'warning'
                                : 'danger'
                          }
                        >
                          <Chip.Label>{entry.status}</Chip.Label>
                        </Chip>
                      </td>
                      <td className="py-2 px-2 text-muted">{entry.detail || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}
