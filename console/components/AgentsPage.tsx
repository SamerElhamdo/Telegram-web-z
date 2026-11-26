import { useEffect, useState } from 'react';
import { Alert, Button, Card, Input, Label, Spinner, TextArea } from '@heroui/react';

import type { DialogSummary, PublicAccountSummary, PublicAgentConfig } from '../lib/api';
import { consoleApi } from '../lib/api';

type AgentDraft = {
  id?: string;
  name: string;
  accountId: string;
  chatId: string;
  providerUrl: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
  systemPrompt: string;
  tools: PublicAgentConfig['tools'];
  isEnabled: boolean;
};

const EMPTY_DRAFT: AgentDraft = {
  name: '', accountId: '', chatId: '', providerUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
  apiKey: '', clearApiKey: false, systemPrompt: 'أنت مساعد دعم محترف. أجب عن استفسارات أعضاء المجموعة بإيجاز ووضوح.',
  tools: ['read_group_messages', 'reply_to_group'], isEnabled: false,
};

export function AgentsPage({ accounts }: { accounts: PublicAccountSummary[] }) {
  const [agents, setAgents] = useState<PublicAgentConfig[]>([]);
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT);
  const [dialogs, setDialogs] = useState<DialogSummary[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [feedback, setFeedback] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);

  async function refresh() {
    const result = await consoleApi.listAgents();
    setAgents(result.agents);
  }

  useEffect(() => { void refresh().catch((err: unknown) => setFeedback(err instanceof Error ? err.message : 'تعذر تحميل الوكلاء')); }, []);
  useEffect(() => {
    if (!draft.accountId) { setDialogs([]); return; }
    void consoleApi.listDialogs(draft.accountId, 100)
      .then(({ dialogs: result }) => setDialogs(result.filter((dialog) => ['group', 'supergroup'].includes(dialog.type))))
      .catch((err: unknown) => setFeedback(err instanceof Error ? err.message : 'تعذر تحميل المجموعات'));
  }, [draft.accountId]);

  function editAgent(agent: PublicAgentConfig) {
    setDraft({ ...agent, apiKey: '', clearApiKey: false });
    setApiKey('');
  }

  async function saveAgent(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsSaving(true);
    setFeedback(undefined);
    try {
      const { apiKey: _key, clearApiKey, ...config } = draft;
      await consoleApi.saveAgent({ ...config, apiKey: apiKey || undefined, clearApiKey });
      await refresh();
      setFeedback('تم حفظ إعدادات الوكيل في الخزنة المشفّرة.');
      setDraft(EMPTY_DRAFT);
      setApiKey('');
    } catch (err: unknown) {
      setFeedback(err instanceof Error ? err.message : 'تعذر حفظ الوكيل');
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteAgent(id: string) {
    await consoleApi.deleteAgent(id);
    await refresh();
    if (draft.id === id) setDraft(EMPTY_DRAFT);
  }

  function toggleTool(tool: AgentDraft['tools'][number]) {
    setDraft((current) => ({
      ...current,
      tools: current.tools.includes(tool) ? current.tools.filter((item) => item !== tool) : [...current.tools, tool],
    }));
  }

  return (
    <div className="space-y-5">
      <Alert status="accent">
        <Alert.Indicator /><Alert.Content><Alert.Title>وكلاء الذكاء الاصطناعي</Alert.Title>
          <Alert.Description>إعدادات المزود والمفتاح والتعليمات والمجموعة محفوظة مشفّرة. تراقب الخدمة تحديثات الجلسة للمجموعة المختارة، ولا ترسل رداً إلا عند تفعيل الوكيل وأداة الرد.</Alert.Description>
        </Alert.Content>
      </Alert>
      {feedback && <p className="text-sm text-muted" role="status">{feedback}</p>}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <Card className="p-4">
          <Card.Header><Card.Title>{draft.id ? 'تعديل الوكيل' : 'إضافة وكيل'}</Card.Title></Card.Header>
          <form className="space-y-4" onSubmit={(e) => void saveAgent(e)}>
            <div className="grid gap-3 md:grid-cols-2">
              <Label>اسم الوكيل<Input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Label>
              <Label>حساب Telegram<select required className="w-full rounded-lg border border-border bg-background p-2" value={draft.accountId} onChange={(e) => setDraft({ ...draft, accountId: e.target.value, chatId: '' })}>
                <option value="">اختر الحساب</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
              </select></Label>
              <Label>مجموعة Telegram<select required className="w-full rounded-lg border border-border bg-background p-2" value={draft.chatId} onChange={(e) => setDraft({ ...draft, chatId: e.target.value })}>
                <option value="">اختر المجموعة</option>{dialogs.map((dialog) => <option key={dialog.chatId} value={dialog.chatId}>{dialog.title}</option>)}
              </select></Label>
              <Label>رابط API متوافق مع OpenAI<Input required type="url" value={draft.providerUrl} onChange={(e) => setDraft({ ...draft, providerUrl: e.target.value })} /></Label>
              <Label>اسم النموذج<Input required value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} /></Label>
              <Label>مفتاح API<Input type="password" autoComplete="new-password" value={apiKey} placeholder={draft.id ? (agents.find((agent) => agent.id === draft.id)?.hasApiKey ? 'محفوظ؛ اتركه فارغاً للإبقاء عليه' : 'أدخل المفتاح') : 'أدخل المفتاح'} onChange={(e) => setApiKey(e.target.value)} /></Label>
            </div>
            {draft.id && agents.find((agent) => agent.id === draft.id)?.hasApiKey && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.clearApiKey} onChange={(e) => setDraft({ ...draft, clearApiKey: e.target.checked })} />حذف مفتاح API المحفوظ</label>}
            <Label>System prompt<TextArea required rows={5} value={draft.systemPrompt} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} /></Label>
            <fieldset className="space-y-2"><legend className="text-sm font-medium">الأدوات المسموحة</legend>
              {([['read_group_messages', 'قراءة رسائل المجموعة'], ['search_group_messages', 'البحث في المجموعة'], ['reply_to_group', 'الرد في المجموعة']] as const).map(([tool, label]) => (
                <label className="flex items-center gap-2 text-sm" key={tool}><input type="checkbox" checked={draft.tools.includes(tool)} onChange={() => toggleTool(tool)} />{label}</label>
              ))}
            </fieldset>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.isEnabled} onChange={(e) => setDraft({ ...draft, isEnabled: e.target.checked })} />تفعيل الوكيل</label>
            <div className="flex gap-2"><Button type="submit" isDisabled={isSaving || !accounts.length}>{isSaving ? <Spinner /> : 'حفظ الوكيل'}</Button>
              {draft.id && <Button type="button" variant="secondary" onPress={() => { setDraft(EMPTY_DRAFT); setApiKey(''); }}>إلغاء التعديل</Button>}</div>
          </form>
        </Card>
        <div className="space-y-3">{agents.length ? agents.map((agent) => <Card className="p-4 space-y-3" key={agent.id}>
          <div><h3 className="font-semibold">{agent.name}</h3><p className="text-xs text-muted">{accounts.find((account) => account.id === agent.accountId)?.label || agent.accountId} · {agent.chatId}</p>
            <p className="text-xs">{agent.isEnabled ? 'مفعّل' : 'متوقف'} · {agent.hasApiKey ? 'المفتاح محفوظ' : 'لا يوجد مفتاح'}</p></div>
          <div className="flex gap-2"><Button size="sm" variant="secondary" onPress={() => editAgent(agent)}>تعديل</Button><Button size="sm" variant="danger-soft" onPress={() => void deleteAgent(agent.id)}>حذف</Button></div>
        </Card>) : <p className="text-sm text-muted">لا توجد وكلاء محفوظون بعد.</p>}</div>
      </div>
    </div>
  );
}
