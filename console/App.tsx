import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  Spinner,
  Tabs,
} from '@heroui/react';

import type { PublicAccountSummary } from './lib/api';

import { AccountsPage } from './components/AccountsPage';
import { AgentsPage } from './components/AgentsPage';
import { AdminLoginGate } from './components/AdminLoginGate';
import { ChatsAndApprovalsPage } from './components/ChatsAndApprovalsPage';
import { McpSettingsPage } from './components/McpSettingsPage';
import { consoleApi, setCsrfToken } from './lib/api';

export function App() {
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<'gramjs' | 'mock'>('gramjs');
  const [accounts, setAccounts] = useState<PublicAccountSummary[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
  const [globalError, setGlobalError] = useState<string | undefined>();
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  const refreshAccounts = useCallback(async () => {
    setIsLoadingAccounts(true);
    setGlobalError(undefined);
    try {
      const res = await consoleApi.listAccounts();
      setAccounts(res.accounts);
      setRuntimeMode(res.runtimeMode);
    } catch (err: unknown) {
      setGlobalError(err instanceof Error ? err.message : 'تعذر تحميل قائمة الحسابات');
    } finally {
      setIsLoadingAccounts(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const me = await consoleApi.getAuthMe();
        if (me.authenticated) {
          setCsrfToken(me.csrfToken);
          setIsAuthenticated(true);
          if (me.runtimeMode) setRuntimeMode(me.runtimeMode);
          await refreshAccounts();
        }
      } catch {
        setIsAuthenticated(false);
      } finally {
        setIsCheckingAuth(false);
      }
    })();
  }, [refreshAccounts]);

  async function handleLogin(token: string) {
    const res = await consoleApi.login(token);
    setCsrfToken(res.csrfToken);
    setIsAuthenticated(true);
    if (res.runtimeMode) setRuntimeMode(res.runtimeMode);
    await refreshAccounts();
  }

  async function handleLogout() {
    await consoleApi.logout();
    setCsrfToken(undefined);
    setIsAuthenticated(false);
    setAccounts([]);
  }

  if (isCheckingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center gap-3 text-muted">
        <Spinner />
        <span>جارٍ التحقق من جلسة الإدارة...</span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AdminLoginGate onLogin={handleLogin} />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-lg font-bold">لوحة إدارة Telegram و MCP</h1>
            <Chip color="warning" variant="soft" size="sm">
              <Chip.Label>عميل غير رسمي (Web Z + MTProto WSS)</Chip.Label>
            </Chip>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <a
              href="/"
              className="inline-flex items-center justify-center rounded-full border border-border px-3.5 py-1.5 text-sm font-medium hover:bg-default/50"
            >
              فتح Telegram Web Z
            </a>
            <Button variant="secondary" size="sm" onPress={() => setIsDark((prev) => !prev)}>
              {isDark ? 'الوضع النهاري' : 'الوضع الليلي'}
            </Button>
            <Button variant="danger-soft" size="sm" onPress={() => void handleLogout()}>
              تسجيل الخروج
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6 space-y-5">
        {globalError && (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>خطأ عام</Alert.Title>
              <Alert.Description>{globalError}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        <Tabs defaultSelectedKey="accounts">
          <Tabs.ListContainer>
            <Tabs.List aria-label="أقسام لوحة الإدارة">
              <Tabs.Tab id="accounts">
                الحسابات والاتصال ({accounts.length})
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="chats">
                المحادثات والموافقات
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="agents">
                وكلاء الذكاء الاصطناعي
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="mcp">
                إعدادات MCP والأمان
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>

          <Tabs.Panel id="accounts" className="pt-5">
            <AccountsPage
              accounts={accounts}
              runtimeMode={runtimeMode}
              isLoading={isLoadingAccounts}
              onRefreshAccounts={refreshAccounts}
            />
          </Tabs.Panel>

          <Tabs.Panel id="chats" className="pt-5">
            <ChatsAndApprovalsPage accounts={accounts} />
          </Tabs.Panel>

          <Tabs.Panel id="agents" className="pt-5">
            <AgentsPage accounts={accounts} />
          </Tabs.Panel>

          <Tabs.Panel id="mcp" className="pt-5">
            <McpSettingsPage />
          </Tabs.Panel>
        </Tabs>
      </main>

      <footer className="border-t border-border py-4 px-4 text-center text-xs text-muted">
        تطبيق ويب خاص غير رسمي مبني على Telegram Web Z (رخصة GNU GPL-3.0-or-later) • لا يُستخدم Telegram Bot API بديلاً عن جلسة المستخدم • لا تُعرض أي أسرار أو مفاتيح جلسة في الواجهة.
      </footer>
    </div>
  );
}
