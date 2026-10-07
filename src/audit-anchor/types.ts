export type SyncSource = "AUTO" | "MANUAL" | "RECONCILIATION";

export type SubmissionMode = "SERVICE" | "WALLET";

export type BatchStatus =
  | "BUILDING"
  | "READY"
  | "READY_FOR_WALLET"
  | "SUBMITTING"
  | "SUBMITTED"
  | "VERIFYING"
  | "CONFIRMED"
  | "SUBMISSION_FAILED"
  | "SUBMISSION_UNKNOWN"
  | "VERIFICATION_FAILED";
export interface SyncOptions {
  jobId?: string;
  tenantId?: string;
  maxEvents?: number;
}

export interface AuditBatch {
  id: string;
  tenant_id: string;
  idempotency_key: string;

  merkle_root: string;
  event_count: number;

  period_start: Date | string;
  period_end: Date | string;

  status: BatchStatus;

  hedera_topic_id: string | null;
  hedera_transaction_id: string | null;
  hedera_sequence_number: string | null;
  hedera_consensus_timestamp: string | null;
  wallet_transaction_bytes: string | null;

  attempt_count: number;
  last_error: string | null;
  last_attempt_at: Date | string | null;
  next_retry_at: Date | string | null;

  processing_started_at: Date | string | null;
  processing_completed_at: Date | string | null;

  created_at: Date | string;
  submitted_at: Date | string | null;
  confirmed_at: Date | string | null;
}

export interface HederaSubmissionInput {
  batchId: string;
  merkleRoot: string;
}

export interface HederaSubmissionReceipt {
  topicId: string;
  transactionId?: string;
  sequenceNumber?: string;
  consensusTimestamp?: string;
}

export type HederaSubmissionResult =
  | {
      status: "SUBMITTED";
      receipt: HederaSubmissionReceipt;
    }
  | {
      status: "FAILED";
      error: string;
    }
  | {
      status: "UNKNOWN";
      error: string;
      transactionId?: string;
    };

export class SubmissionUnknownError extends Error {
  constructor(
    message: string,
    public readonly transactionId?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SubmissionUnknownError";
  }
}

export interface MirrorMessageDetails {
  version: number;
  batchId: string;
  merkleRoot: string;
  hashAlgorithm: string;
  eventCount?: number;
}

export interface FindBatchMessageInput {
  topicId: string;
  batchId: string;
  merkleRoot: string;
  payerAccountId?: string;
}

export interface VerifyMirrorMessageInput extends FindBatchMessageInput {
  sequenceNumber: string;
}

export type MirrorNodeLookupResult =
  | {
      status: "FOUND";
      topicId: string;
      sequenceNumber: string;
      consensusTimestamp: string;
      transactionId?: string;
      message: MirrorMessageDetails;
    }
  | {
      status: "NOT_FOUND";
      reason: "NOT_INDEXED" | "SEARCH_COMPLETED";
    };

export interface PrepareWalletInput {
  tenantId?: string;
  maxEvents?: number;
  payerAccountId: string;
}

export interface PreparedWalletTransaction {
  batchId: string;
  payerAccountId: string;
  merkleRoot?: string;
  topicId: string;
  message: string;
}

export interface PreparedWalletBatch extends PreparedWalletTransaction {
  batchId: string;
  tenantId: string;
  status: "READY_FOR_WALLET";
  eventCount: number;
  merkleRoot: string;
  logs: Array<{
    auditLogId: string;
    leafIndex: number;
    leafHash: string;
    merkleProof: string[];
  }>;
}
export interface WalletSubmissionInput {
  transactionId?: string;
  topicId: string;
  sequenceNumber: string;
  consensusTimestamp?: string;
}
export interface VerifyWalletTransactionInput {
  topicId: string;
  transactionId: string;
  payerAccountId: string;
  batchId: string;
  merkleRoot: string;
}
export interface WalletMirrorVerification {
  topicId: string;
  transactionId?: string;
  payerAccountId: string;
  sequenceNumber: string;
  consensusTimestamp: string;
  message: MirrorMessageDetails;
}

export interface BatchRow {
  id: string;
  tenant_id: string;

  merkle_root: string | null;
  event_count: number;

  status: BatchStatus;
  submission_mode: SubmissionMode;
  payer_account_id: string | null;

  hedera_topic_id: string | null;
  hedera_transaction_id: string | null;
  hedera_sequence_number: string | null;
  hedera_consensus_timestamp: string | null;
  wallet_transaction_bytes: string | null;

  attempt_count: number;
  last_attempt_at: Date | null;
  next_retry_at: Date | null;

  processing_started_at: Date | null;
  processing_completed_at: Date | null;
}
