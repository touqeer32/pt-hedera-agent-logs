import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditAnchorService } from "./audit-anchor.service";
import { BatchService } from "./batch.service";
import { MirrorNodeService } from "./mirror-node.service";
import { BatchRow } from "./types";
import { hederaTopicId } from "./hedera-config";

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly batches: BatchService,
    private readonly anchor: AuditAnchorService,
    private readonly mirror: MirrorNodeService,
  ) {}

  async run(): Promise<void> {
    const batches = await this.batches.readyForReconciliation();

    for (const batch of batches) {
      try {
        await this.reconcileBatch(batch);
      } catch (error) {
        this.logger.error(
          `Reconciliation failed for batch ${batch.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  private async reconcileBatch(batch: BatchRow): Promise<void> {
    if (batch.submission_mode === "WALLET") {
      switch (batch.status) {
        case "SUBMITTED":
        case "SUBMISSION_UNKNOWN":
        case "VERIFYING":
        case "VERIFICATION_FAILED":
          await this.anchor.verifyWalletBatch(batch.id);

          return;

        default:
          return;
      }
    }

    switch (batch.status) {
      case "READY":
        await this.anchor.retryStoredBatch(batch.id);

        return;

      case "SUBMISSION_FAILED":
        await this.retryFailedBatch(batch);

        return;

      case "SUBMISSION_UNKNOWN":
        if (!batch.hedera_transaction_id) {
          this.logger.warn(
            `Wallet batch ${batch.id} is SUBMISSION_UNKNOWN without a transaction ID`,
          );

          return;
        }

        await this.anchor.verifyWalletBatch(batch.id);

        return;

      case "SUBMITTED":
      case "VERIFYING":
      case "VERIFICATION_FAILED":
        await this.anchor.retryStoredBatch(batch.id);
        return;

      case "SUBMITTING":
        await this.reconcileStaleSubmittingBatch(batch);

        return;

      default:
        return;
    }
  }

  private async retryFailedBatch(batch: BatchRow): Promise<void> {
    if (
      batch.next_retry_at &&
      new Date(batch.next_retry_at).getTime() > Date.now()
    ) {
      return;
    }

    await this.anchor.retryStoredBatch(batch.id);
  }
  private async reconcileUnknownBatch(batch: BatchRow): Promise<void> {
    if (!batch.merkle_root) {
      throw new Error(`Batch ${batch.id} has no stored Merkle root`);
    }
    const result = await this.mirror.findBatchMessage({
      topicId:
        batch.hedera_topic_id ??
        hederaTopicId(this.config),
      batchId: batch.id,
      merkleRoot: batch.merkle_root,
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
          : batch.hedera_transaction_id
            ? {
                hedera_transaction_id: batch.hedera_transaction_id,
              }
            : {}),

        last_error: null,
        next_retry_at: null,
      });

      await this.batches.markConfirmed(batch.id, result.consensusTimestamp);

      return;
    }

    if (!this.safeWaitingPeriodFinished(batch)) {
      /*
       * Do not change the root or resubmit.
       * Schedule another Mirror Node check.
       */
      await this.batches.setStatus(batch.id, "SUBMISSION_UNKNOWN", {
        next_retry_at: this.calculateSafeWaitEnd(batch),
      });

      return;
    }

    /*
     * Mirror Node did not find the message after the safe
     * waiting period. Retry the same saved batch/root.
     */
    await this.anchor.retryStoredBatch(batch.id);
  }

  private async reconcileStaleSubmittingBatch(batch: BatchRow): Promise<void> {
    const staleAfterMs = Number(
      this.config.get("SUBMITTING_STALE_AFTER_MS", 5 * 60 * 1000),
    );

    if (!batch.last_attempt_at) {
      return;
    }

    const isStale =
      Date.now() - new Date(batch.last_attempt_at).getTime() >= staleAfterMs;

    if (!isStale) {
      return;
    }

    const nextCheckAt = this.calculateSafeWaitEnd(batch);

    await this.batches.markSubmissionUnknown(
      batch.id,
      "Submission worker stopped before storing the receipt",
      nextCheckAt,
      batch.hedera_transaction_id ?? undefined,
    );

    await this.reconcileUnknownBatch({
      ...batch,
      status: "SUBMISSION_UNKNOWN",
      next_retry_at: nextCheckAt,
    });
  }

  private safeWaitingPeriodFinished(batch: BatchRow): boolean {
    return Date.now() >= this.calculateSafeWaitEnd(batch).getTime();
  }

  private calculateSafeWaitEnd(batch: BatchRow): Date {
    const waitMs = Number(
      this.config.get("SUBMISSION_UNKNOWN_WAIT_MS", 5 * 60 * 1000),
    );

    const attemptTime = batch.last_attempt_at
      ? new Date(batch.last_attempt_at).getTime()
      : batch.processing_started_at
        ? new Date(batch.processing_started_at).getTime()
        : Date.now();

    return new Date(attemptTime + waitMs);
  }
}
