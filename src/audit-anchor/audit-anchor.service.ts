import {
  Inject,
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool, PoolClient } from "pg";
import { PG_POOL } from "../database/database.module";
import { BatchService } from "./batch.service";
import { MirrorNodeService } from "./mirror-node.service";

import { HederaService, SubmissionFailedError } from "./hedera.service";

import {
  BatchRow,
  PreparedWalletBatch,
  PrepareWalletInput,
  SubmissionUnknownError,
  SyncOptions,
  SyncSource,
} from "./types";
import { MerkleService } from "./merkle.service";

@Injectable()
export class AuditAnchorService {
  private readonly log = new Logger(AuditAnchorService.name);
  private static readonly LOCK = 781244991;
  constructor(
    @Inject(PG_POOL) private readonly db: Pool,
    private readonly config: ConfigService,
    private readonly batches: BatchService,
    private readonly hedera: HederaService,
    private readonly mirror: MirrorNodeService,
    private readonly merkle: MerkleService,
  ) {}
  async createJob(source: SyncSource, o: SyncOptions = {}) {
    return (
      await this.db.query(
        `INSERT INTO audit_sync_jobs(source,status,tenant_id,max_events) VALUES($1,'QUEUED',$2,$3) RETURNING id`,
        [source, o.tenantId ?? null, o.maxEvents ?? null],
      )
    ).rows[0].id as string;
  }
  private get unknownSubmissionWaitMs(): number {
    return Number(this.config.get("SUBMISSION_UNKNOWN_WAIT_MS", 5 * 60 * 1000));
  }
  start(jobId: string, source: SyncSource, o: SyncOptions = {}) {
    setImmediate(
      () =>
        void this.runSync(source, { ...o, jobId }).catch((e) =>
          this.log.error(e),
        ),
    );
  }
  retryBatch(batchId: string) {
    setImmediate(
      () =>
        void (async () => {
          const b = await this.batches.get(batchId);
          if (!b) return;

          // First search Mirror Node because the wallet may have submitted
          // successfully even when the UI did not receive a transaction ID.
          if (
            b.submission_mode === "WALLET" &&
            ["VERIFICATION_FAILED", "SUBMISSION_UNKNOWN"].includes(b.status) &&
            !b.hedera_transaction_id
          ) {
            await this.reconcileUnknownSubmission(b.id);
            return;
          }

          await this.processBatch(b);
        })().catch((e) => this.log.error(e)),
    );
  }
  async runSync(source: SyncSource, o: SyncOptions = {}) {
    const c = await this.db.connect();

    let lockAcquired = false;

    try {
      lockAcquired = (
        await c.query(
          `
        SELECT
          pg_try_advisory_lock($1)
            AS ok
        `,
          [AuditAnchorService.LOCK],
        )
      ).rows[0].ok;

      if (!lockAcquired) {
        await this.finish(o.jobId, "SKIPPED");

        return;
      }

      // Existing processing...
    } finally {
      try {
        if (lockAcquired) {
          await c.query(
            `
          SELECT
            pg_advisory_unlock($1)
          `,
            [AuditAnchorService.LOCK],
          );
        }
      } finally {
        c.release();
      }
    }
  }
  async retryStoredBatch(batchId: string): Promise<void> {
    await this.submitStoredBatch(batchId);
  }

  private async submitStoredBatch(batchId: string): Promise<void> {
    const batch = await this.batches.get(batchId);

    if (!batch) {
      throw new Error(`Batch ${batchId} not found`);
    }

    if (batch.submission_mode === "WALLET") {
      throw new ConflictException(
        "Wallet batches cannot be submitted using the service operator",
      );
    }

    if (!batch.merkle_root) {
      throw new Error(`Batch ${batchId} has no stored Merkle root`);
    }
    await this.batches.beginSubmissionAttempt(batchId);

    try {
      const receipt = await this.hedera.submit({
        batchId: batch.id,
        merkleRoot: batch.merkle_root,
      });

      await this.batches.markSubmitted(batchId, receipt);

      await this.verifySubmittedBatch(batchId);
    } catch (error) {
      if (error instanceof SubmissionUnknownError) {
        await this.batches.markSubmissionUnknown(
          batchId,
          error,
          new Date(Date.now() + this.unknownSubmissionWaitMs),
          error.transactionId,
        );

        return;
      }

      if (error instanceof SubmissionFailedError) {
        await this.batches.markSubmissionFailed(
          batchId,
          error,
          this.calculateNextRetry(Number(batch.attempt_count ?? 0) + 1),
        );

        return;
      }
      const uncertainError =
        error instanceof Error ? error : new Error(String(error));

      await this.batches.markSubmissionUnknown(
        batchId,
        uncertainError,
        new Date(Date.now() + this.unknownSubmissionWaitMs),
      );
    }
  }
  private async verifySubmittedBatch(batchId: string): Promise<void> {
    const batch = await this.batches.get(batchId);

    if (!batch) {
      throw new Error(`Batch ${batchId} not found`);
    }

    if (!batch.hedera_topic_id || !batch.merkle_root) {
      throw new Error(`Batch ${batchId} does not have a complete HCS receipt`);
    }
    await this.batches.setStatus(batchId, "VERIFYING");

    try {
      let result:
        | Awaited<ReturnType<typeof this.mirror.verifyBySequence>>
        | Awaited<ReturnType<typeof this.mirror.verifyWalletTransaction>>
        | null = null;

      if (batch.hedera_sequence_number) {
        result = await this.mirror.verifyBySequence({
          topicId: batch.hedera_topic_id,
          sequenceNumber: String(batch.hedera_sequence_number),
          batchId: batch.id,
          merkleRoot: batch.merkle_root,
        });
      } else if (batch.hedera_transaction_id) {
        result = await this.mirror.verifyWalletTransaction({
          topicId: batch.hedera_topic_id,
          transactionId: batch.hedera_transaction_id,
          payerAccountId: batch.payer_account_id ?? "",
          batchId: batch.id,
          merkleRoot: batch.merkle_root,
        });
      }

      if (!result || ("status" in result && result.status === "NOT_FOUND")) {
        await this.batches.setStatus(batchId, "SUBMITTED", {
          next_retry_at: new Date(Date.now() + 30_000),
        });

        return;
      }

      const consensusTimestamp = result.consensusTimestamp;

      await this.batches.markConfirmed(batchId, consensusTimestamp);
    } catch (error) {
      await this.batches.setStatus(batchId, "VERIFICATION_FAILED", {
        last_error: error instanceof Error ? error.message : String(error),
        next_retry_at: new Date(Date.now() + 60_000),
      });
    }
  }
  async reconcileUnknownSubmission(batchId: string): Promise<void> {
    const batch = await this.batches.get(batchId);
    if (!batch) {
      throw new Error(`Batch ${batchId} not found`);
    }
    if (!batch.merkle_root) {
      throw new Error(`Batch ${batch.id} has no stored Merkle root`);
    }

    const result = await this.mirror.findBatchMessage({
      topicId:
        batch.hedera_topic_id ??
        this.config.getOrThrow<string>("HEDERA_TOPIC_ID"),
      batchId: batch.id,
      merkleRoot: batch.merkle_root,
      payerAccountId: batch.payer_account_id ?? undefined,
    });

    if (result.status === "FOUND") {
      await this.batches.setStatus(batch.id, "SUBMITTED", {
        hedera_topic_id: result.topicId,

        hedera_sequence_number: result.sequenceNumber,

        hedera_consensus_timestamp: result.consensusTimestamp,

        submitted_at: new Date(),

        ...(result.transactionId
          ? {
              hedera_transaction_id: result.transactionId,
            }
          : {}),

        last_error: null,
        next_retry_at: null,
      });

      await this.batches.markConfirmed(batch.id, result.consensusTimestamp);

      return;
    }
    const safeWaitMs = Number(
      this.config.get("SUBMISSION_UNKNOWN_WAIT_MS", 5 * 60 * 1000),
    );

    const lastAttemptAt = batch.last_attempt_at
      ? new Date(batch.last_attempt_at).getTime()
      : Date.now();

    const safeWaitFinished = Date.now() - lastAttemptAt >= safeWaitMs;

    if (!safeWaitFinished) {
      await this.batches.setStatus(batch.id, "SUBMISSION_UNKNOWN", {
        next_retry_at: new Date(lastAttemptAt + safeWaitMs),
      });

      return;
    }

    if (batch.submission_mode === "WALLET" && !batch.hedera_transaction_id) {
      await this.batches.setStatus(batch.id, "READY_FOR_WALLET", {
        submitted_at: null,
        confirmed_at: null,
        processing_completed_at: null,
        wallet_transaction_bytes: null,
        last_error: null,
        next_retry_at: null,
      });
      return;
    }

    /* Retry the same batch ID and stored Merkle root. */
    await this.submitStoredBatch(batch.id);
  }
  private calculateNextRetry(attemptCount: number): Date {
    const baseDelayMs = 60_000;
    const maximumDelayMs = 30 * 60_000;

    const delayMs = Math.min(
      baseDelayMs * 2 ** Math.max(attemptCount - 1, 0),
      maximumDelayMs,
    );

    return new Date(Date.now() + delayMs);
  }
  async processBatch(batch: BatchRow): Promise<void> {
    if (batch.status === "CONFIRMED") {
      return;
    }

    /*
     * Wallet batches must be separated before
     * checking the normal service statuses.
     */
    if (batch.submission_mode === "WALLET") {
      if (
        [
          "SUBMITTED",
          "SUBMISSION_UNKNOWN",
          "VERIFYING",
          "VERIFICATION_FAILED",
        ].includes(batch.status)
      ) {
        await this.verifyWalletBatch(batch.id);
      }

      /*
       * READY_FOR_WALLET waits for the UI.
       * Never use the service operator wallet.
       */
      return;
    }

    if (batch.status === "READY" || batch.status === "SUBMISSION_FAILED") {
      await this.submitStoredBatch(batch.id);

      return;
    }

    if (batch.status === "SUBMISSION_UNKNOWN") {
      await this.reconcileUnknownSubmission(batch.id);

      return;
    }

    if (
      batch.status === "SUBMITTED" ||
      batch.status === "VERIFICATION_FAILED"
    ) {
      await this.verifySubmittedBatch(batch.id);

      return;
    }

    if (batch.status === "SUBMITTING") {
      return;
    }
  }
  async prepareWalletTransaction(batchId: string, payerAccountId: string) {
    if (!payerAccountId) {
      throw new BadRequestException("payerAccountId is required");
    }

    this.hedera.validateWalletPreparation(payerAccountId);

    const batch = await this.batches.get(batchId);

    if (!batch) {
      throw new NotFoundException("Batch not found");
    }

    if (batch.submission_mode !== "WALLET") {
      throw new ConflictException("Batch is not a wallet batch");
    }

    if (batch.status !== "READY_FOR_WALLET") {
      throw new ConflictException(
        `Cannot prepare transaction while batch is ${batch.status}`,
      );
    }

    if (batch.payer_account_id !== payerAccountId) {
      throw new ConflictException(
        "Wallet payer cannot be changed for this batch",
      );
    }

    if (!batch.merkle_root) {
      throw new Error(`Batch ${batch.id} has no stored Merkle root`);
    }

    const transaction = await this.prepareStoredWalletTransaction(
      batch,
      payerAccountId,
    );

    return {
      ...transaction,
      batchId: batch.id,
      merkleRoot: batch.merkle_root,
      status: batch.status,
    };
  }
  async recordWalletSubmission(
    batchId: string,
    input: {
      transactionId?: string;
      topicId: string;
      sequenceNumber?: string;
      consensusTimestamp?: string;
    },
  ) {
    const { transactionId, topicId, sequenceNumber, consensusTimestamp } = input;
    if (!topicId) {
      throw new BadRequestException("topicId is required");
    }

    const batch = await this.batches.get(batchId);

    if (!batch) {
      throw new NotFoundException("Batch not found");
    }

    if (batch.submission_mode !== "WALLET") {
      throw new ConflictException("Batch is not a wallet batch");
    }

    if (!["READY_FOR_WALLET", "SUBMISSION_UNKNOWN"].includes(batch.status)) {
      throw new ConflictException(
        `Cannot report submission while batch is ${batch.status}`,
      );
    }

    if (batch.hedera_topic_id && topicId !== batch.hedera_topic_id) {
      throw new BadRequestException("Topic ID does not match the prepared transaction");
    }

    if (transactionId) {
      const transactionPayer = transactionId.split("@")[0];

      if (transactionPayer !== batch.payer_account_id) {
        throw new BadRequestException(
          "Transaction payer does not match the prepared wallet",
        );
      }
    }

    if (!transactionId) {
      await this.batches.setStatus(batch.id, "SUBMISSION_UNKNOWN", {
        hedera_topic_id: topicId,
        hedera_sequence_number: sequenceNumber?.trim() || null,
        hedera_consensus_timestamp: consensusTimestamp?.trim() || null,
        submitted_at: new Date(),
        last_error: null,
        next_retry_at: new Date(),
      });
    } else {
      await this.batches.markWalletSubmitted(batch.id, {
        transactionId,
        topicId,
        sequenceNumber,
        consensusTimestamp,
      });
    }

    /*
     * Do not keep the HTTP request open while
     * waiting for Mirror Node.
     */
    setImmediate(() => {
      const verification = transactionId
        ? this.verifyWalletBatch(batch.id)
        : this.reconcileUnknownSubmission(batch.id);
      void verification.catch(async (error: unknown) => {
        this.log.error(error);

        await this.batches.setStatus(batch.id, "VERIFICATION_FAILED", {
          last_error: error instanceof Error ? error.message : String(error),

          next_retry_at: new Date(Date.now() + 30_000),
        });
      });
    });

    return {
      accepted: true,
      batchId: batch.id,
      status: transactionId ? "SUBMITTED" : "SUBMISSION_UNKNOWN",
    };
  }
  async verifyWalletBatch(batchId: string): Promise<void> {
    const batch = await this.batches.get(batchId);

    if (!batch) {
      throw new NotFoundException("Batch not found");
    }

    if (batch.submission_mode !== "WALLET") {
      throw new ConflictException("Batch is not a wallet batch");
    }

    if (!batch.merkle_root) {
      throw new Error(`Batch ${batch.id} has no stored Merkle root`);
    }

    if (
      !batch.hedera_topic_id ||
      !batch.hedera_transaction_id ||
      !batch.payer_account_id
    ) {
      throw new Error("Wallet batch submission metadata is incomplete");
    }

    await this.batches.setStatus(batch.id, "VERIFYING");

    const result = await this.mirror.verifyWalletTransaction({
      topicId: batch.hedera_topic_id,

      transactionId: batch.hedera_transaction_id,

      payerAccountId: batch.payer_account_id,

      batchId: batch.id,

      merkleRoot: batch.merkle_root,
    });

    if (!result) {
      /*
       * Mirror Node has not indexed it yet.
       * Keep it submitted and never resubmit.
       */
      await this.batches.setStatus(batch.id, "SUBMITTED", {
        next_retry_at: new Date(Date.now() + 30_000),
      });

      return;
    }

    const completedAt = new Date();

    await this.batches.setStatus(batch.id, "CONFIRMED", {
      hedera_transaction_id: result.transactionId,
      hedera_sequence_number: result.sequenceNumber,

      hedera_consensus_timestamp: result.consensusTimestamp,

      confirmed_at: completedAt,

      processing_completed_at: completedAt,

      last_error: null,
      next_retry_at: null,
    });
  }
  private async prepareStoredWalletTransaction(
    batch: BatchRow,
    payerAccountId: string,
  ) {
    if (!batch.merkle_root) {
      throw new Error(`Batch ${batch.id} has no stored Merkle root`);
    }

    const transaction = await this.hedera.prepareWalletTransaction({
      batchId: batch.id,
      merkleRoot: batch.merkle_root,
      payerAccountId,
      transactionId: batch.hedera_transaction_id ?? undefined,
    });

    // The wallet may assign a new valid-start time when it submits. Keep the
    // prepared ID out of hedera_transaction_id; that field is for the actual
    // submitted transaction returned by the wallet or Mirror Node.
    await this.batches.markReadyForWallet(batch.id, {
      topicId: transaction.topicId,
      payerAccountId,
      transactionBytes: transaction.transactionBytes,
    });

    return transaction;
  }
  async getBatchDetails(batchId: string) {
    const batch = await this.batches.get(batchId);

    if (!batch) {
      throw new NotFoundException("Batch not found");
    }

    let transactionBytes = batch.wallet_transaction_bytes;

    if (
      batch.submission_mode === "WALLET" &&
      batch.status === "READY_FOR_WALLET" &&
      !transactionBytes &&
      batch.payer_account_id &&
      batch.merkle_root
    ) {
      const transaction = await this.hedera.prepareWalletTransaction({
        batchId: batch.id,
        merkleRoot: batch.merkle_root,
        payerAccountId: batch.payer_account_id,
        transactionId: batch.hedera_transaction_id ?? undefined,
      });

      transactionBytes = transaction.transactionBytes;

      await this.batches.markReadyForWallet(batch.id, {
        topicId: batch.hedera_topic_id ?? transaction.topicId,
        payerAccountId: batch.payer_account_id,
        transactionBytes,
      });
    }

    return {
      ...batch,
      transactionBytes,
      logs: await this.batches.getBatchItems(batch.id, 20),
      logsTotal: Number(batch.event_count),
      logsReturned: Math.min(Number(batch.event_count), 20),
    };
  }
  async prepareWalletBatches(input: PrepareWalletInput): Promise<PreparedWalletBatch> {
    if (!input.payerAccountId) {
      throw new BadRequestException("payerAccountId is required");
    }

    /*
     * Validate the wallet account, topic ID and
     * topic-submit key before assigning any logs.
     */
    this.hedera.validateWalletPreparation(input.payerAccountId);

    const configuredMaximum = Number(this.config.get("BATCH_MAX_EVENTS", 1000));

    let remaining = Math.min(
      input.maxEvents ?? configuredMaximum,
      configuredMaximum,
    );

    if (!Number.isInteger(remaining) || remaining < 1) {
      throw new BadRequestException("maxEvents must be a positive integer");
    }

    const batchId = await this.batches.createNext(
      input.tenantId,
      remaining,
      "WALLET",
      input.payerAccountId,
    );

    if (!batchId) {
      throw new NotFoundException("No unprocessed audit logs available");
    }

    const batch = await this.batches.get(batchId);

    if (!batch) {
      throw new Error(`Prepared batch ${batchId} not found`);
    }

    if (!batch.merkle_root) {
      throw new Error(`Prepared batch ${batchId} has no stored Merkle root`);
    }

    const transaction = await this.prepareStoredWalletTransaction(
      batch,
      input.payerAccountId,
    );

    return {
      ...transaction,
      batchId: batch.id,
      tenantId: batch.tenant_id,
      status: "READY_FOR_WALLET",
      eventCount: Number(batch.event_count),
      merkleRoot: batch.merkle_root,
      logs: await this.batches.getBatchItems(batch.id),
    };
  }
  async job(id: string) {
    return (
      (await this.db.query("SELECT * FROM audit_sync_jobs WHERE id=$1", [id]))
        .rows[0] ?? null
    );
  }
  private async finish(id: string | undefined, status: string) {
    if (id)
      await this.db.query(
        "UPDATE audit_sync_jobs SET status=$2,completed_at=NOW() WHERE id=$1",
        [id, status],
      );
  }
  async verifyLog(auditLogId: string) {
    const auditLog = await this.batches.getAuditLog(auditLogId);

    if (!auditLog) {
      return {
        auditLogId,
        status: "NOT_FOUND",
        assignedToBatch: false,
        verified: false,
        message: "Audit log does not exist",
      };
    }

    const record = await this.batches.getLogProof(auditLogId);

    if (!record) {
      return {
        auditLogId,
        status: "UNPROCESSED",
        assignedToBatch: false,
        eventHash: auditLog.event_hash,
        actionType: auditLog.action_type,
        logStatus: auditLog.status,
        eventHashMatchesLeaf: false,
        merkleProofValid: false,
        hederaAnchorValid: false,
        mirrorStatus: "NOT_SUBMITTED",
        verified: false,
        message: "Audit log exists but is not assigned to a batch",
      };
    }

    const eventHashMatchesLeaf =
      record.event_hash.toLowerCase() === record.leaf_hash.toLowerCase();

    const proof = Array.isArray(record.merkle_proof)
      ? record.merkle_proof
      : JSON.parse(record.merkle_proof);

    const merkleProofValid = this.merkle.verify(
      record.leaf_hash,
      proof,
      record.merkle_root,
    );

    let hederaAnchorValid = false;
    let mirrorStatus: "FOUND" | "NOT_FOUND" | "NOT_SUBMITTED" = "NOT_SUBMITTED";

    if (record.hedera_topic_id && record.hedera_sequence_number) {
      const mirrorResult = await this.mirror.verifyBySequence({
        topicId: record.hedera_topic_id,
        sequenceNumber: String(record.hedera_sequence_number),
        batchId: record.batch_id,
        merkleRoot: record.merkle_root,
      });

      mirrorStatus = mirrorResult.status;
      hederaAnchorValid = mirrorResult.status === "FOUND";
    } else if (record.hedera_topic_id && record.hedera_transaction_id) {
      const mirrorResult = await this.mirror.verifyWalletTransaction({
        topicId: record.hedera_topic_id,
        transactionId: record.hedera_transaction_id,
        payerAccountId: record.payer_account_id ?? "",
        batchId: record.batch_id,
        merkleRoot: record.merkle_root,
      });

      mirrorStatus = mirrorResult ? "FOUND" : "NOT_FOUND";
      hederaAnchorValid = Boolean(mirrorResult);
    }

    return {
      auditLogId: record.audit_log_id,
      batchId: record.batch_id,
      leafIndex: record.leaf_index,

      eventHashMatchesLeaf,
      merkleProofValid,
      hederaAnchorValid,
      mirrorStatus,

      batchStatus: record.batch_status,
      consensusTimestamp: record.hedera_consensus_timestamp,

      verified: eventHashMatchesLeaf && merkleProofValid && hederaAnchorValid,
    };
  }
  async getLogDetails(auditLogId: string) {
    const log = await this.batches.getAuditLogDetails(auditLogId);

    if (!log) {
      throw new NotFoundException(`Audit log ${auditLogId} not found`);
    }

    return log;
  }
}
