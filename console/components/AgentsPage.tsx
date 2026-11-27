import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Chip,
  Dropdown,
  Input,
  Label,
  ListBox,
  Select,
  Spinner,
  Switch,
  TextArea,
} from '@heroui/react';

import type { DialogSummary, OpenRouterModel, PublicAccountSummary, PublicAgentConfig } from '../lib/api';
import { consoleApi } from '../lib/api';

type AgentDraft = {
  id?: string;
  name: string;
  accountId: string;
  chatId: string;
  providerUrl: string;
  model: string;
  persona: NonNullable<PublicAgentConfig['persona']>;
  systemPrompt: string;
  tools: PublicAgentConfig['tools'];
  memoryMessages: number;
  isEnabled: boolean;
};

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MEMORY_OPTIONS = [20, 40, 60];
const EMPTY_PERSONA = {
  name: '', role: 'مساعد المجموعة', region: '', dialect: '', tone: 'ودود ولطيف', formality: 'عفوي ومختصر', ageStyle: '',
};
const TOOL_OPTIONS: { id: PublicAgentConfig['tools'][number]; title: string; description: string }[] = [
  { id: 'read_group_messages', title: 'قراءة رسائل المجموعة', description: 'يقرأ سياق المحادثة قبل صياغة الرد.' },
  { id: 'search_group_messages', title: 'البحث في سجل المجموعة', description: 'يعثر على إجابات أو معلومات وردت سابقاً.' },
  { id: 'reply_to_group', title: 'الرد وذكر الأعضاء', description: 'يرد على الرسالة التي أشارت للحساب، ويمكنه ذكر عضو باستخدام @username.' },
];
const DEFAULT_SYSTEM_PROMPT = `أنت مساعد المجموعة. اكتب كأنك تشارك في محادثة عادية، بدون تكلف أو رسمية زائدة.

أسلوبك:
- أجب بلغة صاحب الرسالة وبصياغة طبيعية وودودة ومختصرة.
- استخدم اللهجة المحددة في إعدادات الهوية عند الكتابة بالعربية.
- تجنب العبارات الجاهزة، والتنسيق أو التعداد إلا عندما يفيدان فعلاً.
- اعتمد على ذاكرة المجموعة ورسائلها عند توفرها.
- لا تخترع معلومات أو وعوداً. إذا لم تعرف الإجابة، قل ذلك بوضوح واطلب توضيحاً.
- لا ترد إلا عندما تكون الرسالة قد أشارت إلى حسابك.
- يمكنك ذكر عضو مناسب باستخدام @username إذا كان ذلك يساعد على حل الطلب.
- أرسل رداً واحداً مناسباً للرسالة، ولا تكرر التحية في كل رد.
- لا تختلق أخطاء إملائية أو تجارب شخصية لتبدو كشخص حقيقي.`;

const EMPTY_DRAFT: AgentDraft = {
  name: '', accountId: '', chatId: '', providerUrl: OPENROUTER_BASE_URL, model: '', persona: EMPTY_PERSONA,
  systemPrompt: DEFAULT_SYSTEM_PROMPT, tools: ['read_group_messages', 'search_group_messages', 'reply_to_group'],
  memoryMessages: 20, isEnabled: true,
};

export function AgentsPage({ accounts }: { accounts: PublicAccountSummary[] }) {
  const [agents, setAgents] = useState<PublicAgentConfig[]>([]);
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT);
  const [dialogs, setDialogs] = useState<DialogSummary[]>([]);
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [hasOpenRouterKey, setHasOpenRouterKey] = useState(false);
  const [groupSearch, setGroupSearch] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string }>();
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isLoadingDialogs, setIsLoadingDialogs] = useState(false);

  async function refreshAgents() {
    const result = await consoleApi.listAgents();
    setAgents(result.agents);
  }

  useEffect(() => {
    void refreshAgents().catch((err: unknown) => setFeedback({ type: 'error', text: getErrorMessage(err, 'تعذر تحميل الوكلاء') }));
    void consoleApi.getOpenRouterSettings().then(({ hasApiKey: hasKey }) => setHasOpenRouterKey(hasKey))
      .catch((err: unknown) => setFeedback({ type: 'error', text: getErrorMessage(err, 'تعذر تحميل إعداد OpenRouter') }));
  }, []);

  useEffect(() => {
    if (!draft.accountId) {
      setDialogs([]);
      return;
    }
    setIsLoadingDialogs(true);
    void consoleApi.listDialogs(draft.accountId, 100)
      .then(({ dialogs: result }) => setDialogs(result.filter((dialog) => ['group', 'supergroup'].includes(dialog.type))))
      .catch((err: unknown) => setFeedback({ type: 'error', text: getErrorMessage(err, 'تعذر تحميل المجموعات') }))
      .finally(() => setIsLoadingDialogs(false));
  }, [draft.accountId]);

  async function loadModels() {
    setIsLoadingModels(true);
    setFeedback(undefined);
    try {
      const result = await consoleApi.listOpenRouterModels();
      setModels(result.models);
      if (result.models.length && !result.models.some((model) => model.id === draft.model)) {
        setDraft((current) => ({ ...current, model: result.models[0].id }));
      }
    } catch (err: unknown) {
      setFeedback({ type: 'error', text: getErrorMessage(err, 'تعذر تحميل قائمة النماذج') });
    } finally {
      setIsLoadingModels(false);
    }
  }

  function editAgent(agent: PublicAgentConfig) {
    setDraft({
      id: agent.id,
      name: agent.name,
      accountId: agent.accountId,
      chatId: agent.chatId,
      providerUrl: OPENROUTER_BASE_URL,
      model: agent.model,
      persona: agent.persona || EMPTY_PERSONA,
      systemPrompt: agent.systemPrompt,
      tools: agent.tools,
      memoryMessages: Math.max(20, agent.memoryMessages),
      isEnabled: agent.isEnabled,
    });
    setGroupSearch('');
    setModels([]);
    setFeedback(undefined);
  }

  function startNewAgent() {
    setDraft(EMPTY_DRAFT);
    setGroupSearch('');
    setModels([]);
    setFeedback(undefined);
  }

  async function saveAgent(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsSaving(true);
    setFeedback(undefined);
    try {
      const result = await consoleApi.saveAgent({ ...draft, providerUrl: OPENROUTER_BASE_URL });
      await refreshAgents();
      setFeedback({ type: 'success', text: `تم حفظ «${result.agent.name}» وإعداد ذاكرته المشفّرة.` });
      startNewAgent();
    } catch (err: unknown) {
      setFeedback({ type: 'error', text: getErrorMessage(err, 'تعذر حفظ الوكيل') });
    } finally {
      setIsSaving(false);
    }
  }

  async function saveOpenRouterKey() {
    setIsSaving(true);
    setFeedback(undefined);
    try {
      const { hasApiKey: hasKey } = await consoleApi.saveOpenRouterApiKey(apiKey);
      setHasOpenRouterKey(hasKey);
      setApiKey('');
      setFeedback({ type: 'success', text: 'تم حفظ مفتاح OpenRouter المشترك. أصبح متاحاً لكل الوكلاء.' });
    } catch (err: unknown) {
      setFeedback({ type: 'error', text: getErrorMessage(err, 'تعذر حفظ مفتاح OpenRouter') });
    } finally {
      setIsSaving(false);
    }
  }

  async function clearOpenRouterKey() {
    try {
      await consoleApi.clearOpenRouterApiKey();
      setHasOpenRouterKey(false);
      setModels([]);
      setFeedback({ type: 'success', text: 'تم حذف مفتاح OpenRouter المشترك.' });
    } catch (err: unknown) {
      setFeedback({ type: 'error', text: getErrorMessage(err, 'تعذر حذف مفتاح OpenRouter') });
    }
  }

  async function deleteAgent(id: string) {
    try {
      await consoleApi.deleteAgent(id);
      await refreshAgents();
      if (draft.id === id) startNewAgent();
    } catch (err: unknown) {
      setFeedback({ type: 'error', text: getErrorMessage(err, 'تعذر حذف الوكيل') });
    }
  }

  function toggleTool(tool: AgentDraft['tools'][number]) {
    setDraft((current) => ({
      ...current,
      tools: current.tools.includes(tool) ? current.tools.filter((item) => item !== tool) : [...current.tools, tool],
    }));
  }

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/15 via-background to-background p-5 sm:p-7">
        <div className="relative z-10 max-w-3xl space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Chip color="accent" variant="soft" size="sm"><Chip.Label>OpenRouter · Telegram MTProto</Chip.Label></Chip>
            <Chip color="success" variant="soft" size="sm"><Chip.Label>{agents.filter((agent) => agent.isEnabled).length} نشط</Chip.Label></Chip>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">مساعدو مجموعاتك</h2>
          <p className="max-w-2xl text-sm leading-7 text-muted">
            اربط جلسة Telegram بمجموعة، اختر نموذج OpenRouter، واكتب أسلوب الرد. يستجيب الوكيل عند منشن الحساب فقط، ويحفظ آخر الرسائل كذاكرة نصية عادية.
          </p>
        </div>
        <div aria-hidden="true" className="pointer-events-none absolute -left-10 -top-16 size-60 rounded-full bg-primary/10 blur-3xl" />
      </section>

      {feedback && <Alert status={feedback.type === 'error' ? 'danger' : 'success'}><Alert.Indicator /><Alert.Content><Alert.Description>{feedback.text}</Alert.Description></Alert.Content></Alert>}

      <Card>
        <Card.Header className="border-b border-border px-5 py-4">
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <div className="space-y-1"><Card.Title>اتصال الذكاء الاصطناعي</Card.Title><Card.Description>أضف مفتاح OpenRouter مرة واحدة ليستخدمه كل الوكلاء.</Card.Description></div>
            <Chip color={hasOpenRouterKey ? 'success' : 'warning'} variant="soft" size="sm"><Chip.Label>{hasOpenRouterKey ? 'المفتاح محفوظ ومشفّر' : 'المفتاح غير مضبوط'}</Chip.Label></Chip>
          </div>
        </Card.Header>
        <Card.Content className="grid gap-3 p-5 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
          <div className="space-y-2"><Label htmlFor="shared-openrouter-key">مفتاح OpenRouter المشترك</Label><Input id="shared-openrouter-key" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasOpenRouterKey ? 'المفتاح محفوظ؛ أدخل قيمة جديدة للاستبدال' : 'أدخل المفتاح'} /></div>
          <Button isDisabled={!apiKey.trim() || isSaving} onPress={() => void saveOpenRouterKey()}>{isSaving ? <><Spinner size="sm" /> جارٍ الحفظ</> : 'حفظ المفتاح'}</Button>
          <div className="flex gap-2"><Button variant="secondary" isDisabled={!hasOpenRouterKey || isLoadingModels} onPress={() => void loadModels()}>{isLoadingModels ? <Spinner size="sm" /> : 'اختبار وتحميل النماذج'}</Button>{hasOpenRouterKey && <Button variant="ghost" onPress={() => void clearOpenRouterKey()}>حذف</Button>}</div>
        </Card.Content>
      </Card>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(19rem,0.85fr)]">
        <Card className="overflow-hidden">
          <Card.Header className="border-b border-border bg-default/20 px-5 py-4">
            <div className="flex w-full items-start justify-between gap-3">
              <div className="space-y-1">
                <Card.Title>{draft.id ? 'إعدادات الوكيل' : 'إعداد وكيل جديد'}</Card.Title>
                <Card.Description>أكمل الخطوات بالترتيب؛ تحفظ المفاتيح والذاكرة داخل الخزنة المشفّرة.</Card.Description>
              </div>
              {draft.id && <Button size="sm" variant="secondary" onPress={startNewAgent}>وكيل جديد</Button>}
            </div>
          </Card.Header>

          <Card.Content className="p-5">
            <form className="space-y-7" onSubmit={(e) => void saveAgent(e)}>
              <FormSection number="01" title="جلسة Telegram" description="اختر الحساب الذي سيستقبل المنشنات ويرد من خلاله.">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Select
                    fullWidth
                    isRequired
                    placeholder="اختر جلسة مرتبطة"
                    value={draft.accountId || null}
                    onChange={(value) => setDraft((current) => ({ ...current, accountId: String(value || ''), chatId: '' }))}
                  >
                    <Label>الحساب المرتبط</Label>
                    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                    <Select.Popover><ListBox>
                      {accounts.map((account) => <ListBox.Item key={account.id} id={account.id} textValue={account.label}>
                        <span>{account.label}</span><span className="ms-auto text-xs text-muted">DC {account.mainDcId}</span><ListBox.ItemIndicator />
                      </ListBox.Item>)}
                    </ListBox></Select.Popover>
                  </Select>

                  <Select
                    fullWidth
                    isRequired
                    isDisabled={!draft.accountId || isLoadingDialogs || dialogs.length === 0}
                    placeholder={isLoadingDialogs ? 'جارٍ تحميل المجموعات...' : 'اختر مجموعة'}
                    value={draft.chatId || null}
                    onChange={(value) => setDraft((current) => ({ ...current, chatId: String(value || '') }))}
                  >
                    <Label>المجموعة المستهدفة</Label>
                    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                    <Select.Popover>
                      <div className="border-b border-border p-2"><Input aria-label="ابحث عن مجموعة" placeholder="ابحث عن مجموعة..." value={groupSearch} onChange={(e) => setGroupSearch(e.target.value)} /></div>
                      <ListBox>
                      {dialogs.filter((dialog) => dialog.title.toLocaleLowerCase().includes(groupSearch.toLocaleLowerCase())).map((dialog) => <ListBox.Item key={dialog.chatId} id={dialog.chatId} textValue={dialog.title}>
                        <span>{dialog.title}</span><span className="ms-auto text-xs text-muted">{dialog.type === 'supergroup' ? 'مجموعة فائقة' : 'مجموعة'}</span><ListBox.ItemIndicator />
                      </ListBox.Item>)}
                    </ListBox></Select.Popover>
                  </Select>
                </div>
                {!accounts.length && <p className="text-sm text-warning">اربط جلسة من تبويب الحسابات أولاً، وستظهر هنا تلقائياً.</p>}
                {draft.accountId && !isLoadingDialogs && dialogs.length === 0 && <p className="text-sm text-muted">لم نجد مجموعات في هذا الحساب. تحقق من أن الجلسة عضو في المجموعة المطلوبة.</p>}
                <div className="space-y-2">
                  <Label htmlFor="agent-name">اسم الوكيل</Label>
                  <Input id="agent-name" required value={draft.name} onChange={(e) => setDraft((current) => ({ ...current, name: e.target.value }))} />
                </div>
              </FormSection>

              <FormSection number="02" title="اختيار النموذج" description="يستخدم هذا الوكيل مفتاح OpenRouter المشترك المحفوظ في إعدادات الاتصال أعلاه.">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-default/20 p-3">
                  <div className="space-y-1"><div className="font-medium">OpenRouter</div><p className="text-xs text-muted">واجهة متوافقة مع OpenAI · {OPENROUTER_BASE_URL}</p></div>
                  <a className="text-xs text-primary underline-offset-4 hover:underline" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">إنشاء مفتاح</a>
                </div>
                {!hasOpenRouterKey && <p className="text-sm text-warning">احفظ مفتاح OpenRouter في بطاقة الاتصال أعلاه أولاً.</p>}
                <Button type="button" variant="secondary" isDisabled={isLoadingModels || !hasOpenRouterKey} onPress={() => void loadModels()}>{isLoadingModels ? <><Spinner size="sm" /> تحميل النماذج</> : 'تحديث النماذج'}</Button>
                <Select
                  fullWidth
                  isRequired
                  isDisabled={!models.length}
                  placeholder={models.length ? 'اختر النموذج' : 'حمّل النماذج من إعداد الاتصال أعلاه'}
                  value={draft.model || null}
                  onChange={(value) => setDraft((current) => ({ ...current, model: String(value || '') }))}
                >
                  <Label>نموذج OpenRouter</Label>
                  <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                  <Select.Popover><ListBox>
                    {models.map((model) => <ListBox.Item key={model.id} id={model.id} textValue={`${model.name} ${model.id}`}>
                      <span>{model.name}</span><span className="ms-auto font-mono text-[11px] text-muted ltr-inline">{model.id}</span><ListBox.ItemIndicator />
                    </ListBox.Item>)}
                  </ListBox></Select.Popover>
                </Select>
                {models.length > 0 && <p className="text-xs text-muted">{models.length} نموذجاً يدعم إكمال المحادثة والأدوات متاح للاختيار.</p>}
              </FormSection>

              <FormSection number="03" title="هوية الوكيل وأسلوبه" description="حدد الاسم واللهجة والنبرة التي يلتزم بها في المجموعة.">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="persona-name">اسم الشخصية</Label>
                    <Input id="persona-name" maxLength={80} value={draft.persona.name} onChange={(e) => setDraft((current) => ({ ...current, persona: { ...current.persona, name: e.target.value } }))} placeholder="مثلاً: ليان" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="persona-role">الدور</Label>
                    <Input id="persona-role" maxLength={120} value={draft.persona.role} onChange={(e) => setDraft((current) => ({ ...current, persona: { ...current.persona, role: e.target.value } }))} placeholder="مثلاً: مساعدة المجموعة" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="persona-region">البلد أو المنطقة</Label>
                    <Input id="persona-region" maxLength={120} value={draft.persona.region} onChange={(e) => setDraft((current) => ({ ...current, persona: { ...current.persona, region: e.target.value } }))} placeholder="مثلاً: دمشق، سوريا" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="persona-dialect">اللهجة</Label>
                    <Input id="persona-dialect" maxLength={120} value={draft.persona.dialect} onChange={(e) => setDraft((current) => ({ ...current, persona: { ...current.persona, dialect: e.target.value } }))} placeholder="مثلاً: شامية خفيفة" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="persona-age-style">الطابع العمري للصوت (اختياري)</Label>
                    <Input id="persona-age-style" maxLength={80} value={draft.persona.ageStyle} onChange={(e) => setDraft((current) => ({ ...current, persona: { ...current.persona, ageStyle: e.target.value } }))} placeholder="مثلاً: شاب وبسيط" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="persona-tone">النبرة</Label>
                    <Input id="persona-tone" maxLength={120} value={draft.persona.tone} onChange={(e) => setDraft((current) => ({ ...current, persona: { ...current.persona, tone: e.target.value } }))} placeholder="مثلاً: ودود، هادئ، مرح" />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="persona-formality">طريقة الكلام</Label>
                    <Input id="persona-formality" maxLength={80} value={draft.persona.formality} onChange={(e) => setDraft((current) => ({ ...current, persona: { ...current.persona, formality: e.target.value } }))} placeholder="مثلاً: عفوي ومختصر، بدون مبالغة بالرسمية" />
                  </div>
                </div>
                <p className="text-xs leading-5 text-muted">الطابع يوجه أسلوب الرد فقط؛ لا يدّعي الوكيل عمراً أو تجارب شخصية حقيقية. وإذا سُئل مباشرة عن طبيعته، يجيب بصدق وباختصار.</p>
              </FormSection>

              <FormSection number="04" title="الذاكرة والتعليمات" description="ذاكرة نصية متحركة؛ لا تستخدم قاعدة بيانات متجهية أو تضمينات.">
                <Select
                  fullWidth
                  value={String(draft.memoryMessages)}
                  onChange={(value) => setDraft((current) => ({ ...current, memoryMessages: Math.max(20, Number(value) || 20) }))}
                >
                  <Label>عدد الرسائل في الذاكرة</Label>
                  <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                  <Select.Popover><ListBox>
                    {MEMORY_OPTIONS.map((count) => <ListBox.Item key={count} id={String(count)} textValue={`${count} رسالة`}>{count} رسالة<ListBox.ItemIndicator /></ListBox.Item>)}
                  </ListBox></Select.Popover>
                </Select>
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label>تعليمات الوكيل (System prompt)</Label>
                    <Button type="button" size="sm" variant="ghost" onPress={() => setDraft((current) => ({ ...current, systemPrompt: DEFAULT_SYSTEM_PROMPT }))}>استعادة القالب</Button>
                  </div>
                  <TextArea
                    required
                    rows={12}
                    maxLength={12000}
                    className="font-mono text-sm leading-7"
                    value={draft.systemPrompt}
                    onChange={(e) => setDraft((current) => ({ ...current, systemPrompt: e.target.value }))}
                    placeholder="حدد شخصية الوكيل، نبرة الرد، قواعد الإجابة، ومتى يذكر أعضاء المجموعة..."
                  />
                  <p className="text-xs text-muted">القالب يوضح متى يرد وكيف يتعامل مع المعلومات غير المؤكدة. عدّله ليتناسب مع عمل مجموعتك.</p>
                  <p className="text-end text-xs text-muted">{draft.systemPrompt.length.toLocaleString('ar')} / 12,000</p>
                </div>
              </FormSection>

              <FormSection number="05" title="الصلاحيات والتشغيل" description="القدرات متاحة من أول إعداد. لا يوجد طلب موافقة منفصل قبل الرد.">
                <div className="grid gap-2 md:grid-cols-3">
                  {TOOL_OPTIONS.map((tool) => <Checkbox key={tool.id} isSelected={draft.tools.includes(tool.id)} onChange={() => toggleTool(tool.id)} className="rounded-xl border border-border p-3">
                    <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control><span className="space-y-1"><span className="block text-sm font-medium">{tool.title}</span><span className="block text-xs leading-5 text-muted">{tool.description}</span></span></Checkbox.Content>
                  </Checkbox>)}
                </div>
                <div className="flex items-center justify-between gap-4 rounded-xl border border-border p-4">
                  <div><p className="font-medium">تشغيل الرد التلقائي</p><p className="mt-1 text-xs text-muted">يرد عند منشن الحساب فقط؛ لا يتفاعل مع الرسائل العادية.</p></div>
                  <Switch isSelected={draft.isEnabled} onChange={(isEnabled) => setDraft((current) => ({ ...current, isEnabled }))} aria-label="تشغيل الرد التلقائي">
                    <Switch.Control><Switch.Thumb /></Switch.Control>
                  </Switch>
                </div>
              </FormSection>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
                <p className="max-w-lg text-xs leading-5 text-muted">لن يرسل الوكيل إلا داخل المجموعة المحددة، وبعد منشن الحساب المرتبط.</p>
                <div className="flex gap-2">
                  {draft.id && <Button type="button" variant="secondary" onPress={startNewAgent}>إلغاء</Button>}
                  <Button type="submit" isDisabled={isSaving || !accounts.length || !hasOpenRouterKey || !draft.model || !draft.chatId}>
                    {isSaving ? <><Spinner size="sm" /> جارٍ الحفظ</> : draft.id ? 'حفظ التغييرات' : 'ربط وتشغيل الوكيل'}
                  </Button>
                </div>
              </div>
            </form>
          </Card.Content>
        </Card>

        <section className="space-y-3">
          <div className="flex items-end justify-between gap-3 px-1">
            <div><h3 className="font-semibold">الوكلاء المرتبطون</h3><p className="mt-1 text-xs text-muted">{agents.length} وكيل</p></div>
            <Button size="sm" variant="secondary" onPress={startNewAgent}>إضافة وكيل</Button>
          </div>
          {agents.length ? agents.map((agent) => (
            <Card key={agent.id} className="p-4 transition-colors hover:border-primary/40">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-semibold">{agent.name}</h4>
                    <Chip color={agent.isEnabled ? 'success' : 'default'} variant="soft" size="sm"><Chip.Label>{agent.isEnabled ? 'نشط' : 'متوقف'}</Chip.Label></Chip>
                  </div>
                  <p className="truncate text-sm text-muted">{accounts.find((account) => account.id === agent.accountId)?.label || agent.accountId}</p>
                  <p className="truncate text-xs text-muted">{dialogs.find((dialog) => dialog.chatId === agent.chatId)?.title || agent.chatId}</p>
                  {agent.persona && (agent.persona.name || agent.persona.dialect) && <p className="truncate text-xs text-muted">{[agent.persona.name, agent.persona.dialect].filter(Boolean).join(' · ')}</p>}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <Chip variant="soft" size="sm"><Chip.Label>{agent.model}</Chip.Label></Chip>
                    <Chip variant="soft" size="sm"><Chip.Label>ذاكرة {agent.memoryCount}/{agent.memoryMessages}</Chip.Label></Chip>
                    {hasOpenRouterKey && <Chip color="accent" variant="soft" size="sm"><Chip.Label>OpenRouter متصل</Chip.Label></Chip>}
                  </div>
                </div>
                <Dropdown>
                  <Button aria-label={`خيارات ${agent.name}`} variant="ghost" size="sm">•••</Button>
                  <Dropdown.Popover><Dropdown.Menu onAction={(key) => {
                    if (key === 'edit') editAgent(agent);
                    if (key === 'delete') void deleteAgent(agent.id);
                  }}>
                    <Dropdown.Item id="edit" textValue="تعديل"><Label>تعديل الإعدادات</Label></Dropdown.Item>
                    <Dropdown.Item id="delete" textValue="حذف" variant="danger"><Label>حذف الوكيل</Label></Dropdown.Item>
                  </Dropdown.Menu></Dropdown.Popover>
                </Dropdown>
              </div>
            </Card>
          )) : <Card className="border-dashed p-7 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-xl">✦</div>
            <h4 className="font-medium">ابدأ بأول وكيل</h4>
            <p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-muted">اختر جلسة ومجموعة، ثم حمّل نماذج OpenRouter واربط المساعد.</p>
          </Card>}
        </section>
      </div>
    </div>
  );
}

function FormSection({ number, title, description, children }: { number: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{number}</span>
        <div className="space-y-1"><h3 className="font-semibold">{title}</h3><p className="text-xs leading-5 text-muted">{description}</p></div>
      </div>
      <div className="space-y-4 ps-11">{children}</div>
    </section>
  );
}

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
