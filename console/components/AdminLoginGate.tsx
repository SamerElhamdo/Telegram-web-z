import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Chip,
  Input,
  Label,
  Spinner,
} from '@heroui/react';

type AdminLoginGateProps = {
  onLogin: (token: string) => Promise<void>;
};

export function AdminLoginGate({ onLogin }: AdminLoginGateProps) {
  const [token, setToken] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(undefined);
    try {
      await onLogin(token.trim());
      setToken('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تسجيل الدخول');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-b from-background to-default/30">
      <div className="w-full max-w-lg space-y-4">
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>عميل غير رسمي مبني على Telegram Web Z</Alert.Title>
            <Alert.Description>
              هذا التطبيق يتصل بخوادم Telegram عبر MTProto و WebSocket الآمن (WSS) ولا يتبع رسمياً لشركة Telegram.
              لا تشارك رمز الدخول أو مفاتيح الجلسة في أي محادثة.
            </Alert.Description>
          </Alert.Content>
        </Alert>

        <Card className="p-2">
          <Card.Header className="space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <Card.Title className="text-xl">بوابة إدارة حساب Telegram و MCP</Card.Title>
              <Chip color="accent" variant="soft" size="sm">
                <Chip.Label>جلسة مشفّرة HttpOnly</Chip.Label>
              </Chip>
            </div>
            <Card.Description>
              أدخل رمز الدخول الإداري (ADMIN_AUTH_TOKEN) الخاص باستضافتك للوصول إلى إدارة الحسابات والموافقات وإعدادات MCP.
            </Card.Description>
          </Card.Header>

          <Card.Content>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="admin-token-input">رمز الدخول الإداري</Label>
                <Input
                  id="admin-token-input"
                  type="password"
                  autoComplete="current-password"
                  placeholder="أدخل ADMIN_AUTH_TOKEN"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  fullWidth
                />
              </div>

              {error && (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>فشل التحقق</Alert.Title>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}

              <div className="flex items-center justify-between gap-3 flex-wrap pt-2">
                <Button
                  type="submit"
                  variant="primary"
                  isDisabled={!token.trim() || isSubmitting}
                >
                  {isSubmitting ? (
                    <span className="inline-flex items-center gap-2">
                      <Spinner size="sm" />
                      جارٍ التحقق...
                    </span>
                  ) : 'تسجيل الدخول إلى لوحة الإدارة'}
                </Button>

                <a
                  href="/"
                  className="text-sm font-medium text-accent hover:underline"
                >
                  العودة إلى Telegram Web Z
                </a>
              </div>
            </form>
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}
