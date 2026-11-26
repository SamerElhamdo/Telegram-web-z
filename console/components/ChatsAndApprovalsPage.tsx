import { useCallback, useEffect, useState } from 'react';
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
  TextArea,
} from '@heroui/react';

import type {
  ApprovalItem,
  DialogSummary,
  MessageSummary,
  PublicAccountSummary,
} from '../lib/api';

import { consoleApi } from '../lib/api';

type ChatsAndApprovalsPageProps = {
  accounts: PublicAccountSummary[];
};

const ACTION_LABELS: Record<ApprovalItem['action'], string> = {
  send_message: 'إرسال رسالة',
  create_group: 'إنشاء مجموعة',
  create_channel: 'إنشاء قناة / مجموعة فائقة',
  mark_chat_read: 'تحديد المحادثة كمقروءة',
};

export function ChatsAndApprovalsPage({ accounts }: ChatsAndApprovalsPageProps) {
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [dialogs, setDialogs] = useState<DialogSummary[]>([]);
  const [selectedDialog, setSelectedDialog] = useState<DialogSummary | undefined>();
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);

  const [draftText, setDraftText] = useState('');
  const [isSendConfirmOpen, setIsSendConfirmOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [processingApprovalId, setProcessingApprovalId] = useState<string | undefined>();

  const [isLoadingDialogs, setIsLoadingDialogs] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isLoadingApprovals, setIsLoadingApprovals] = useState(false);
  const [feedback, setFeedback] = useState<{ status: 'success' | 'danger' | 'warning'; text: string } | undefined>();

  useEffect(() => {
    if (!selectedAccountId && accounts.length > 0) {
      setSelectedAccountId(accounts[0].id);
    }
  }, [accounts, selectedAccountId]);

  const selectedAccount = accounts.find((acc) => acc.id === selectedAccountId);

  const loadDialogs = useCallback(async (accountId: string) => {
    setIsLoadingDialogs(true);
    setFeedback(undefined);
    try {
      const { dialogs: items } = await consoleApi.listDialogs(accountId, 40);
      setDialogs(items);
      if (items.length > 0) {
        setSelectedDialog((prev) => items.find((d) => d.chatId === prev?.chatId) || items[0]);
      } else {
        setSelectedDialog(undefined);
        setMessages([]);
      }
    } catch (err: unknown) {
      setFeedback({ status: 'danger', text: err instanceof Error ? err.message : 'تعذر جلب المحادثات' });
    } finally {
      setIsLoadingDialogs(false);
    }
  }, []);

  const loadMessages = useCallback(async (accountId: string, chatId: string) => {
    setIsLoadingMessages(true);
    setIsSearchMode(false);
    try {
      const { messages: items } = await consoleApi.readMessages(accountId, chatId, 30);
      setMessages(items);
    } catch (err: unknown) {
      setFeedback({ status: 'danger', text: err instanceof Error ? err.message : 'تعذر قراءة الرسائل' });
    } finally {
      setIsLoadingMessages(false);
    }
  }, []);

  const loadApprovals = useCallback(async () => {
    setIsLoadingApprovals(true);
    try {
      const { approvals: items } = await consoleApi.listApprovals();
      setApprovals(items);
    } catch (err: unknown) {
      setFeedback({ status: 'danger', text: err instanceof Error ? err.message : 'تعذر تحميل طلبات الموافقة' });
    } finally {
      setIsLoadingApprovals(false);
    }
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      void loadDialogs(selectedAccountId);
    }
  }, [selectedAccountId, loadDialogs]);

  useEffect(() => {
    if (selectedAccountId && selectedDialog) {
      void loadMessages(selectedAccountId, selectedDialog.chatId);
    }
  }, [selectedAccountId, selectedDialog, loadMessages]);

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  async function handleSearch(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedAccountId || !searchQuery.trim()) return;
    setIsLoadingMessages(true);
    setFeedback(undefined);
    try {
      const { messages: found } = await consoleApi.searchMessages(
        selectedAccountId,
        searchQuery.trim(),
        selectedDialog?.chatId,
      );
      setMessages(found);
      setIsSearchMode(true);
    } catch (err: unknown) {
      setFeedback({ status: 'danger', text: err instanceof Error ? err.message : 'تعذر البحث' });
    } finally {
      setIsLoadingMessages(false);
    }
  }

  async function handleConfirmSendMessage() {
    if (!selectedAccount || !selectedDialog || !draftText.trim() || isSending) return;
    setIsSending(true);
    setFeedback(undefined);
    try {
      await consoleApi.sendMessage(selectedAccount.id, {
        chatId: selectedDialog.chatId,
        text: draftText.trim(),
      });
      setDraftText('');
      setIsSendConfirmOpen(false);
      setFeedback({
        status: 'success',
        text: `تم إرسال الرسالة إلى "${selectedDialog.title}" عبر الحساب "${selectedAccount.label}".`,
      });
      await loadMessages(selectedAccount.id, selectedDialog.chatId);
    } catch (err: unknown) {
      setFeedback({ status: 'danger', text: err instanceof Error ? err.message : 'تعذر إرسال الرسالة' });
    } finally {
      setIsSending(false);
    }
  }

  async function handleApprove(item: ApprovalItem) {
    setProcessingApprovalId(item.id);
    setFeedback(undefined);
    try {
      await consoleApi.approveAction(item.id);
      setFeedback({
        status: 'success',
        text: `تمت الموافقة وتنفيذ "${ACTION_LABELS[item.action]}" على الحساب "${item.accountLabel}".`,
      });
      await loadApprovals();
      if (selectedAccountId === item.accountId && selectedDialog) {
        await loadMessages(selectedAccountId, selectedDialog.chatId);
      }
    } catch (err: unknown) {
      setFeedback({ status: 'danger', text: err instanceof Error ? err.message : 'تعذر تنفيذ الموافقة' });
    } finally {
      setProcessingApprovalId(undefined);
    }
  }

  async function handleReject(item: ApprovalItem) {
    setProcessingApprovalId(item.id);
    setFeedback(undefined);
    try {
      await consoleApi.rejectAction(item.id, 'رفض من المستخدم عبر لوحة الإدارة');
      setFeedback({ status: 'warning', text: `تم رفض الطلب ${item.id}.` });
      await loadApprovals();
    } catch (err: unknown) {
      setFeedback({ status: 'danger', text: err instanceof Error ? err.message : 'تعذر رفض الطلب' });
    } finally {
      setProcessingApprovalId(undefined);
    }
  }

  const pendingApprovalsCount = approvals.filter((a) => a.status === 'pending').length;

  return (
    <div className="space-y-6">
      {feedback && (
        <Alert status={feedback.status}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{feedback.text}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {/* Pending MCP Write Approvals Queue */}
      <Card className="p-2">
        <Card.Header className="flex flex-row items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Card.Title>طابور موافقات وكيل الذكاء الاصطناعي (MCP)</Card.Title>
            <Chip color={pendingApprovalsCount > 0 ? 'warning' : 'default'} variant="soft" size="sm">
              <Chip.Label>{pendingApprovalsCount} بانتظار الموافقة</Chip.Label>
            </Chip>
          </div>
          <Button variant="secondary" size="sm" onPress={() => void loadApprovals()}>
            تحديث الموافقات
          </Button>
        </Card.Header>
        <Card.Content>
          {isLoadingApprovals ? (
            <div className="py-4 flex items-center justify-center gap-2 text-muted">
              <Spinner size="sm" />
              <span>جارٍ تحميل الطلبات...</span>
            </div>
          ) : approvals.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted text-center">
              لا توجد طلبات تغيير (إرسال رسالة / إنشاء مجموعة أو قناة / تعليم كمقروء) من وكيل MCP حالياً.
            </div>
          ) : (
            <div className="space-y-3">
              {approvals.map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-border p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4"
                >
                  <div className="space-y-1.5 text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">{ACTION_LABELS[item.action]}</span>
                      <Chip
                        color={
                          item.status === 'pending'
                            ? 'warning'
                            : item.status === 'executed'
                              ? 'success'
                              : item.status === 'rejected'
                                ? 'danger'
                                : 'default'
                        }
                        variant="soft"
                        size="sm"
                      >
                        <Chip.Label>{formatApprovalStatus(item.status)}</Chip.Label>
                      </Chip>
                      <span className="text-xs text-muted ltr-inline">{item.id}</span>
                    </div>
                    <div>
                      الحساب المستهدف: <strong>{item.accountLabel}</strong>{' '}
                      <span className="text-xs text-muted ltr-inline">({item.accountId})</span>
                    </div>
                    <div>
                      الوجهة المستهدفة: <strong>{item.targetLabel}</strong>
                    </div>
                    <pre className="rounded-lg bg-default/40 p-2 text-xs overflow-x-auto ltr-inline">
                      {JSON.stringify(item.payload, undefined, 2)}
                    </pre>
                  </div>

                  {item.status === 'pending' && (
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        variant="primary"
                        size="sm"
                        isDisabled={processingApprovalId === item.id}
                        onPress={() => void handleApprove(item)}
                      >
                        موافقة وتنفيذ
                      </Button>
                      <Button
                        variant="danger-soft"
                        size="sm"
                        isDisabled={processingApprovalId === item.id}
                        onPress={() => void handleReject(item)}
                      >
                        رفض
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card.Content>
      </Card>

      {/* Dialogs & Messages Workspace */}
      {accounts.length === 0 ? (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>لا يوجد حساب مرتبط بعد</Alert.Title>
            <Alert.Description>
              اربط حساب Telegram من تبويب «الحسابات والاتصال» لعرض المحادثات والرسائل والبحث فيها.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : (
        <Card className="p-2">
          <Card.Header className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <Card.Title>المحادثات والرسائل والبحث</Card.Title>
              <Card.Description>
                اختر الحساب والمحادثة لقراءة الرسائل أو البحث أو الإرسال بعد التأكيد الصريح.
              </Card.Description>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Label htmlFor="active-account-select" className="text-xs text-muted">الحساب النشط:</Label>
              <select
                id="active-account-select"
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.label} (DC {acc.mainDcId})
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                size="sm"
                onPress={() => { if (selectedAccountId) void loadDialogs(selectedAccountId); }}
              >
                تحديث المحادثات
              </Button>
            </div>
          </Card.Header>

          <Card.Content>
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* Dialogs Column */}
              <div className="lg:col-span-4 border border-border rounded-xl p-3 space-y-2 max-h-[34rem] overflow-y-auto">
                <div className="text-xs font-semibold text-muted px-1">المحادثات ({dialogs.length})</div>
                {isLoadingDialogs ? (
                  <div className="py-8 flex justify-center"><Spinner size="sm" /></div>
                ) : dialogs.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted">لا توجد محادثات</div>
                ) : (
                  dialogs.map((dialog) => {
                    const isSelected = selectedDialog?.chatId === dialog.chatId;
                    return (
                      <button
                        key={dialog.chatId}
                        type="button"
                        onClick={() => setSelectedDialog(dialog)}
                        className={`w-full text-start rounded-lg p-3 transition border ${
                          isSelected
                            ? 'border-accent bg-accent/10'
                            : 'border-transparent hover:bg-default/50'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm truncate">{dialog.title}</span>
                          {dialog.unreadCount > 0 && (
                            <Chip color="accent" variant="primary" size="sm">
                              <Chip.Label>{dialog.unreadCount}</Chip.Label>
                            </Chip>
                          )}
                        </div>
                        <div className="text-xs text-muted truncate mt-1">
                          {dialog.lastMessagePreview || 'بدون معاينة نصية'}
                        </div>
                        <div className="text-[11px] text-muted mt-1 ltr-inline">{dialog.chatId}</div>
                      </button>
                    );
                  })
                )}
              </div>

              {/* Messages & Search Column */}
              <div className="lg:col-span-8 border border-border rounded-xl p-4 flex flex-col gap-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <div className="font-semibold">
                      {selectedDialog ? selectedDialog.title : 'اختر محادثة'}
                    </div>
                    {selectedDialog && (
                      <div className="text-xs text-muted ltr-inline">
                        chatId: {selectedDialog.chatId} • {selectedDialog.type}
                      </div>
                    )}
                  </div>

                  <form onSubmit={handleSearch} className="flex items-center gap-2">
                    <Input
                      placeholder="ابحث في الرسائل..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      aria-label="بحث في الرسائل"
                    />
                    <Button type="submit" variant="secondary" size="sm" isDisabled={!searchQuery.trim()}>
                      بحث
                    </Button>
                    {isSearchMode && selectedDialog && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onPress={() => {
                          setSearchQuery('');
                          void loadMessages(selectedAccountId, selectedDialog.chatId);
                        }}
                      >
                        مسح
                      </Button>
                    )}
                  </form>
                </div>

                <Separator />

                <div className="space-y-2 max-h-80 overflow-y-auto min-h-48">
                  {isLoadingMessages ? (
                    <div className="py-10 flex justify-center"><Spinner size="sm" /></div>
                  ) : messages.length === 0 ? (
                    <div className="py-10 text-center text-sm text-muted">
                      {isSearchMode ? 'لا توجد رسائل مطابقة للبحث.' : 'لا توجد رسائل للعرض.'}
                    </div>
                  ) : (
                    messages.map((msg) => (
                      <div
                        key={`${msg.chatId}-${msg.id}`}
                        className={`rounded-xl p-3 text-sm border ${
                          msg.isOutgoing
                            ? 'bg-accent/10 border-accent/30 ms-6'
                            : 'bg-default/30 border-border me-6'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 text-xs text-muted mb-1">
                          <span className="font-medium">{msg.senderName || (msg.isOutgoing ? 'أنت' : 'مستخدم')}</span>
                          <span>#{msg.id} • {new Date(msg.date * 1000).toLocaleString('ar')}</span>
                        </div>
                        <div className="whitespace-pre-wrap break-words">{msg.text || '[رسالة وسائط بدون نص]'}</div>
                      </div>
                    ))
                  )}
                </div>

                <Separator />

                {/* Send Message Box (with mandatory Confirmation Modal) */}
                <div className="space-y-2">
                  <Label htmlFor="compose-message-input">
                    إرسال رسالة (يتطلب تأكيد الحساب والمحادثة المستهدفين قبل الإرسال)
                  </Label>
                  <TextArea
                    id="compose-message-input"
                    rows={3}
                    placeholder={selectedDialog ? `اكتب رسالتك إلى "${selectedDialog.title}"...` : 'اختر محادثة أولاً'}
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    disabled={!selectedDialog}
                    fullWidth
                  />
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs text-muted">
                      {selectedAccount && selectedDialog
                        ? `الهدف: ${selectedAccount.label} ← ${selectedDialog.title}`
                        : 'اختر حساباً ومحادثة'}
                    </span>
                    <Button
                      variant="primary"
                      size="sm"
                      isDisabled={!selectedDialog || !draftText.trim()}
                      onPress={() => setIsSendConfirmOpen(true)}
                    >
                      مراجعة وتأكيد الإرسال
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </Card.Content>
        </Card>
      )}

      {/* Explicit Target Account + Chat Send Confirmation Modal */}
      <Modal isOpen={isSendConfirmOpen} onOpenChange={setIsSendConfirmOpen}>
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>تأكيد إرسال رسالة عبر Telegram</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="space-y-3">
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>تحقق من الحساب والمحادثة المستهدفين</Alert.Title>
                    <Alert.Description>
                      سيتم إرسال الرسالة التالية فعلياً عبر MTProto WSS. تأكد من صحة الوجهة قبل المتابعة.
                    </Alert.Description>
                  </Alert.Content>
                </Alert>

                <div className="rounded-lg border border-border p-3 text-sm space-y-1.5">
                  <div>
                    الحساب المستهدف: <strong>{selectedAccount?.label}</strong>{' '}
                    <span className="text-xs text-muted ltr-inline">({selectedAccount?.id})</span>
                  </div>
                  <div>
                    المحادثة المستهدفة: <strong>{selectedDialog?.title}</strong>{' '}
                    <span className="text-xs text-muted ltr-inline">({selectedDialog?.chatId})</span>
                  </div>
                </div>

                <div className="rounded-lg bg-default/40 p-3 text-sm whitespace-pre-wrap break-words">
                  {draftText}
                </div>
              </Modal.Body>
              <Modal.Footer className="flex gap-2 justify-end">
                <Button variant="secondary" onPress={() => setIsSendConfirmOpen(false)} isDisabled={isSending}>
                  إلغاء
                </Button>
                <Button variant="primary" onPress={() => void handleConfirmSendMessage()} isDisabled={isSending}>
                  {isSending ? 'جارٍ الإرسال...' : 'تأكيد وإرسال الآن'}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

function formatApprovalStatus(status: ApprovalItem['status']): string {
  switch (status) {
    case 'pending':
      return 'بانتظار الموافقة';
    case 'approved':
      return 'معتمد';
    case 'executed':
      return 'تم التنفيذ';
    case 'rejected':
      return 'مرفوض';
    case 'expired':
      return 'منتهي الصلاحية';
  }
}
