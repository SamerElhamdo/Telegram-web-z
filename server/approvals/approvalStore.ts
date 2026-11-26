import { randomUUID } from 'node:crypto';

import { computeCanonicalPayloadHash } from '../security/crypto';

export type WriteActionType =
  | 'send_message'
  | 'create_group'
  | 'create_channel'
  | 'mark_chat_read';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'expired';

export type ApprovalRequestRecord = {
  id: string;
  ownerId: string;
  accountId: string;
  accountLabel: string;
  action: WriteActionType;
  targetLabel: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  executedAt?: number;
  executionResult?: Record<string, unknown>;
  error?: string;
};

const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_APPROVAL_RECORDS = 200;

export class ApprovalStore {
  private readonly records = new Map<string, ApprovalRequestRecord>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_APPROVAL_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  createPending(params: {
    ownerId: string;
    accountId: string;
    accountLabel: string;
    action: WriteActionType;
    targetLabel: string;
    payload: Record<string, unknown>;
  }): ApprovalRequestRecord {
    this.pruneExpired();

    const now = Date.now();
    const record: ApprovalRequestRecord = {
      id: `apr_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      ownerId: params.ownerId,
      accountId: params.accountId,
      accountLabel: params.accountLabel,
      action: params.action,
      targetLabel: params.targetLabel,
      payload: params.payload,
      payloadHash: computeCanonicalPayloadHash({
        accountId: params.accountId,
        action: params.action,
        payload: params.payload,
      }),
      status: 'pending',
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };

    this.records.set(record.id, record);
    this.trimOldRecords();
    return record;
  }

  listForOwner(ownerId: string, status?: ApprovalStatus): ApprovalRequestRecord[] {
    this.pruneExpired();
    return Array.from(this.records.values())
      .filter((record) => record.ownerId === ownerId && (!status || record.status === status))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getForOwner(ownerId: string, approvalId: string): ApprovalRequestRecord | undefined {
    this.pruneExpired();
    const record = this.records.get(approvalId);
    if (!record || record.ownerId !== ownerId) {
      return undefined;
    }
    return record;
  }

  approve(ownerId: string, approvalId: string): ApprovalRequestRecord {
    const record = this.getForOwner(ownerId, approvalId);
    if (!record) {
      throw new Error('Approval request not found');
    }
    if (record.status !== 'pending') {
      throw new Error(`Approval request cannot be approved from state "${record.status}"`);
    }
    record.status = 'approved';
    record.decidedAt = Date.now();
    return record;
  }

  reject(ownerId: string, approvalId: string, reason?: string): ApprovalRequestRecord {
    const record = this.getForOwner(ownerId, approvalId);
    if (!record) {
      throw new Error('Approval request not found');
    }
    if (record.status !== 'pending') {
      throw new Error(`Approval request cannot be rejected from state "${record.status}"`);
    }
    record.status = 'rejected';
    record.decidedAt = Date.now();
    record.error = reason?.slice(0, 200);
    return record;
  }

  consumeApprovedForExecution(params: {
    ownerId: string;
    approvalId: string;
    accountId: string;
    action: WriteActionType;
    payload: Record<string, unknown>;
  }): ApprovalRequestRecord {
    const record = this.getForOwner(params.ownerId, params.approvalId);
    if (!record) {
      throw new Error('Approval request not found or unauthorized');
    }
    if (record.status === 'expired') {
      throw new Error('Approval request has expired');
    }
    if (record.status === 'executed') {
      throw new Error('Approval request has already been consumed');
    }
    if (record.status !== 'approved') {
      throw new Error(`Approval request is not approved (current status: ${record.status})`);
    }

    const expectedHash = computeCanonicalPayloadHash({
      accountId: params.accountId,
      action: params.action,
      payload: params.payload,
    });

    if (record.payloadHash !== expectedHash) {
      throw new Error('Approval payload does not match the approved action parameters');
    }

    record.status = 'executed';
    record.executedAt = Date.now();
    return record;
  }

  markExecuted(
    ownerId: string,
    approvalId: string,
    result?: Record<string, unknown>,
    error?: string,
  ): ApprovalRequestRecord | undefined {
    const record = this.getForOwner(ownerId, approvalId);
    if (!record) return undefined;
    record.status = 'executed';
    record.executedAt = Date.now();
    record.executionResult = result;
    record.error = error;
    return record;
  }

  private pruneExpired() {
    const now = Date.now();
    for (const record of this.records.values()) {
      if ((record.status === 'pending' || record.status === 'approved') && record.expiresAt <= now) {
        record.status = 'expired';
      }
    }
  }

  private trimOldRecords() {
    if (this.records.size <= MAX_APPROVAL_RECORDS) return;
    const sorted = Array.from(this.records.values()).sort((a, b) => a.createdAt - b.createdAt);
    const excess = sorted.length - MAX_APPROVAL_RECORDS;
    for (let i = 0; i < excess; i += 1) {
      this.records.delete(sorted[i].id);
    }
  }
}
