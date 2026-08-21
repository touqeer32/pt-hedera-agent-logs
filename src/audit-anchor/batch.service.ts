import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { Pool, PoolClient } from "pg";
import { PG_POOL } from "../database/database.module";
import { MerkleService } from "./merkle.service";
import { BatchRow, BatchStatus, SubmissionMode } from "./types";

interface HederaSubmissionReceipt {
  topicId: string;
  transactionId?: string;
  sequenceNumber?: string;
  consensusTimestamp?: string;
}
@Injectable()
export class BatchService {
  constructor(
    @Inject(PG_POOL) private readonly db: Pool,
    private readonly merkle: MerkleService,
  ) {}
  async createNext(
    tenantId: string | undefined,
    limit: number,
    submissionMode: SubmissionMode = "SERVICE",
    payerAccountId?: string,
  ): Promise<string | null> {
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      const q = await c.query<{
        id: string;
        tenant_id: string;
        event_hash: string;
        occurred_at: Date;
      }>(
        `
            WITH selected_tenant AS (
              SELECT l.tenant_id
              FROM audit_logs l
              WHERE (
                $1::uuid IS NULL OR
                l.tenant_id = $1
              )
              AND NOT EXISTS (
                SELECT 1
                FROM audit_batch_items i
                WHERE i.audit_log_id = l.id
              )
              ORDER BY
                l.occurred_at,
                l.id
              LIMIT 1
            )
            SELECT
              l.id,
              l.tenant_id,
              l.event_hash,
              l.occurred_at
            FROM audit_logs l
            JOIN selected_tenant t
              ON t.tenant_id = l.tenant_id
            WHERE NOT EXISTS (
              SELECT 1
              FROM audit_batch_items i
              WHERE i.audit_log_id = l.id
            )
            ORDER BY
              l.occurred_at,
              l.id
            FOR UPDATE OF l SKIP LOCKED
            LIMIT $2
        `,
        [tenantId ?? null, limit],
      );
      if (!q.rowCount) {
        await c.query("COMMIT");
        return null;
      }
      const firstTenant = q.rows[0].tenant_id;

      const rows = q.rows;
      const tree = this.merkle.build(rows.map((x) => x.event_hash));
      const key = createHash("sha256")
        .update(`${firstTenant}:${rows.map((x) => x.id).join(",")}`)
        .digest("hex");
      const initialStatus: BatchStatus =
        submissionMode === "WALLET" ? "READY_FOR_WALLET" : "READY";
      const b = await c.query<{
        id: string;
      }>(
        `
          INSERT INTO audit_batches (
            tenant_id,
            idempotency_key,
            merkle_root,
            event_count,
            period_start,
            period_end,
            status,
            submission_mode,
            payer_account_id,
            processing_started_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            NOW()
          )
          RETURNING id
          `,
        [
          firstTenant,
          key,
          tree.root,
          rows.length,
          rows[0].occurred_at,
          rows.at(-1)!.occurred_at,
          initialStatus,
          submissionMode,
          payerAccountId ?? null,
        ],
      );
      for (let i = 0; i < rows.length; i++)
        await c.query(
          `INSERT INTO audit_batch_items(
                batch_id,
                audit_log_id,
                leaf_index,
                leaf_hash,
                merkle_proof
            )
            VALUES($1,$2,$3,$4,$5)`,
          [
            b.rows[0].id,
            rows[i].id,
            i,
            rows[i].event_hash.toLowerCase(),
            JSON.stringify(tree.proofs[i]),
          ],
        );
      await c.query("COMMIT");
      return b.rows[0].id;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async get(id: string): Promise<BatchRow | null> {
    const result = await this.db.query<BatchRow>(
      `
      SELECT *
      FROM audit_batches
      WHERE id = $1
      `,
      [id],
    );

    return result.rows[0] ?? null;
  }
  async list(input: { status?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(Number(input.limit ?? 100), 1), 200);

    if (input.status) {
      return (
        await this.db.query(
          "SELECT * FROM audit_batches WHERE status = $1 ORDER BY created_at DESC LIMIT $2",
          [input.status, limit],
        )
      ).rows;
    }

    return (
      await this.db.query(
        "SELECT * FROM audit_batches ORDER BY created_at DESC LIMIT $1",
        [limit],
      )
    ).rows;
  }
  async setStatus(
    id: string,
    status: BatchStatus,
    extra: Record<string, unknown> = {},
  ) {
    const allowed = [
      "hedera_topic_id",
      "hedera_transaction_id",
      "hedera_sequence_number",
      "hedera_consensus_timestamp",
      "submitted_at",
      "confirmed_at",
      "attempt_count",
      "last_error",
      "last_attempt_at",
      "next_retry_at",
      "processing_started_at",
      "processing_completed_at",
      "payer_account_id",
      "wallet_transaction_bytes",
    ];
    const keys = Object.keys(extra).filter((x) => allowed.includes(x));
    const vals = keys.map((x) => extra[x]);
    await this.db.query(
      `UPDATE audit_batches SET status=$1${keys.map((x, i) => `, ${x}=$${i + 2}`).join("")} WHERE id=$${keys.length + 2}`,
      [status, ...vals, id],
    );
  }
  async readyForReconciliation(limit = 100) {
    return (
      await this.db.query(
        `
      SELECT *
      FROM audit_batches
      WHERE
        (
          status IN (
            'READY',
            'SUBMITTING',
            'SUBMITTED',
            'VERIFYING',
            'SUBMISSION_FAILED',
            'SUBMISSION_UNKNOWN',
            'VERIFICATION_FAILED'
          )
          OR (
            status = 'SUBMISSION_FAILED'
            AND next_retry_at <= NOW()
          )
          OR (
            status = 'SUBMITTING'
            AND last_attempt_at < NOW() - INTERVAL '5 minutes'
          )
        )
        AND (
          next_retry_at IS NULL
          OR next_retry_at <= NOW()
        )
      ORDER BY created_at
      LIMIT $1
      `,
        [limit],
      )
    ).rows;
  }
  async status() {
    return (
      await this.db.query(
        `
        SELECT
          (SELECT count(*) FROM audit_logs)::int AS "totalAudit",
          (SELECT count(*)
           FROM audit_logs l
           WHERE NOT EXISTS (
             SELECT 1 FROM audit_batch_items i
             WHERE i.audit_log_id = l.id
           ))::int AS "unprocessed",
          (SELECT count(*)
           FROM audit_batch_items i
           JOIN audit_batches b ON b.id = i.batch_id
           WHERE b.status IN (
             'READY_FOR_WALLET',
             'SUBMITTING',
             'SUBMITTED',
             'VERIFYING',
             'SUBMISSION_UNKNOWN'
           ))::int AS "readySubmitted",
          (SELECT count(*)
           FROM audit_batch_items i
           JOIN audit_batches b ON b.id = i.batch_id
           WHERE b.status = 'CONFIRMED')::int AS "confirmed",
          (SELECT EXTRACT(EPOCH FROM NOW() - min(occurred_at))
           FROM audit_logs l
           WHERE NOT EXISTS (
             SELECT 1 FROM audit_batch_items i
             WHERE i.audit_log_id = l.id
           )) AS oldest_unbatched_age_seconds,
          (SELECT count(*) FROM audit_batches
           WHERE status LIKE '%FAILED')::int AS failed_batches,
          (SELECT count(*) FROM audit_batches
           WHERE status IN (
             'READY',
             'READY_FOR_WALLET',
             'SUBMITTING',
             'SUBMITTED',
             'VERIFYING',
             'SUBMISSION_UNKNOWN'
           ))::int AS unconfirmed_batches
        `,
      )
    ).rows[0];
  }

  async beginSubmissionAttempt(batchId: string): Promise<void> {
    const result = await this.db.query(
      `
    UPDATE audit_batches
    SET
      status = 'SUBMITTING',
      processing_started_at = COALESCE(
        processing_started_at,
        NOW()
      ),
      attempt_count = attempt_count + 1,
      last_attempt_at = NOW(),
      last_error = NULL,
      next_retry_at = NULL
    WHERE id = $1
      AND status IN (
        'READY',
        'SUBMISSION_FAILED',
        'SUBMISSION_UNKNOWN'
      )
    RETURNING id
    `,
      [batchId],
    );

    if (result.rowCount !== 1) {
      throw new Error(`Batch ${batchId} is not available for submission`);
    }
  }
  async markSubmissionFailed(
    batchId: string,
    error: Error | string,
    nextRetryAt: Date,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : error;

    await this.db.query(
      `
    UPDATE audit_batches
    SET
      status = 'SUBMISSION_FAILED',
      last_error = $2,
      next_retry_at = $3
    WHERE id = $1
      AND status = 'SUBMITTING'
    `,
      [batchId, message, nextRetryAt],
    );
  }
  async markSubmissionUnknown(
    batchId: string,
    error: Error | string,
    nextCheckAt: Date,
    transactionId?: string,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : error;

    await this.db.query(
      `
  UPDATE audit_batches
  SET
    status =
      'SUBMISSION_UNKNOWN',

    last_error = $2,
    next_retry_at = $3,

    hedera_transaction_id =
      COALESCE(
        $4,
        hedera_transaction_id
      )
  WHERE id = $1
    AND status = 'SUBMITTING'
  `,
      [batchId, message, nextCheckAt, transactionId ?? null],
    );
  }

  async markSubmitted(
    batchId: string,
    receipt: HederaSubmissionReceipt,
  ): Promise<void> {
    await this.db.query(
      `
    UPDATE audit_batches
    SET
      status = 'SUBMITTED',
      hedera_topic_id = $2,
      hedera_transaction_id = COALESCE($3, hedera_transaction_id),
      hedera_sequence_number = $4,
      hedera_consensus_timestamp = $5,
      submitted_at = NOW(),
      last_error = NULL,
      next_retry_at = NULL
    WHERE id = $1
      AND status IN (
        'SUBMITTING',
        'SUBMISSION_UNKNOWN'
      )
    `,
      [
        batchId,
        receipt.topicId,
        receipt.transactionId?.trim() || null,
        receipt.sequenceNumber,
        receipt.consensusTimestamp?.trim() || null,
      ],
    );
  }
  async markConfirmed(
    batchId: string,
    consensusTimestamp: string,
  ): Promise<void> {
    const result = await this.db.query(
      `
    UPDATE audit_batches
    SET
      status = 'CONFIRMED',
      hedera_consensus_timestamp = $2,
      confirmed_at = NOW(),
      processing_completed_at = NOW(),
      last_error = NULL,
      next_retry_at = NULL
    WHERE id = $1
      AND status IN (
        'SUBMITTED',
        'VERIFYING',
        'VERIFICATION_FAILED',
        'SUBMISSION_UNKNOWN'
      )
    RETURNING id
    `,
      [batchId, consensusTimestamp],
    );

    if (result.rowCount !== 1) {
      throw new Error(`Batch ${batchId} could not be marked CONFIRMED`);
    }
  }
  async getLogProof(auditLogId: string) {
    const result = await this.db.query(
      `
    SELECT
      l.id AS audit_log_id,
      l.event_hash,

      i.batch_id,
      i.leaf_index,
      i.leaf_hash,
      i.merkle_proof,

      b.merkle_root,
      b.status AS batch_status,
      b.hedera_topic_id,
      b.payer_account_id,
      b.hedera_transaction_id,
      b.hedera_sequence_number,
      b.hedera_consensus_timestamp
    FROM audit_logs l
    JOIN audit_batch_items i
      ON i.audit_log_id = l.id
    JOIN audit_batches b
      ON b.id = i.batch_id
    WHERE l.id = $1
    `,
      [auditLogId],
    );

    return result.rows[0] ?? null;
  }
  async getAuditLog(auditLogId: string) {
    const result = await this.db.query(
      `
    SELECT
      id,
      tenant_id,
      event_hash,
      action_type,
      status
    FROM audit_logs
    WHERE id = $1
    `,
      [auditLogId],
    );

    return result.rows[0] ?? null;
  }

  async markReadyForWallet(
    batchId: string,
    input: {
      topicId: string;
      payerAccountId: string;
      transactionBytes: string;
    },
  ): Promise<void> {
    const result = await this.db.query(
      `
    UPDATE audit_batches
    SET
      status =
        'READY_FOR_WALLET',

      hedera_topic_id = $2,

      payer_account_id = $3,

      wallet_transaction_bytes = $4,

      last_error = NULL,
      next_retry_at = NULL
    WHERE id = $1
      AND submission_mode = 'WALLET'
      AND status =
        'READY_FOR_WALLET'
    RETURNING id
    `,
      [
        batchId,
        input.topicId,
        input.payerAccountId,
        input.transactionBytes,
      ],
    );

    if (result.rowCount !== 1) {
      throw new Error(
        `Batch ${batchId} is not available for wallet preparation`,
      );
    }
  }
  async markWalletSubmitted(
    batchId: string,
    input: {
      transactionId?: string;
      topicId: string;
      sequenceNumber?: string;
      consensusTimestamp?: string;
    },
  ): Promise<void> {
    const result = await this.db.query(
      `
    UPDATE audit_batches
    SET
      status = 'SUBMITTED',
      hedera_topic_id = $2,
      hedera_transaction_id = COALESCE($3, hedera_transaction_id),
      hedera_sequence_number = $4,
      hedera_consensus_timestamp = $5,
      submitted_at = NOW(),
      last_error = NULL,
      next_retry_at = NOW()
    WHERE id = $1
      AND submission_mode = 'WALLET'
      AND status IN (
        'READY_FOR_WALLET',
        'SUBMISSION_UNKNOWN'
      )
    RETURNING id
    `,
      [
        batchId,
        input.topicId,
        input.transactionId?.trim() || null,
        input.sequenceNumber?.trim() || null,
        input.consensusTimestamp?.trim() || null,
      ],
    );

    if (result.rowCount !== 1) {
      throw new Error(
        `Batch ${batchId} is not available for wallet submission`,
      );
    }
  }
  async getBatchItems(batchId: string, limit?: number) {
    const values: unknown[] = [batchId];
    const limitClause = limit
      ? (() => {
          values.push(Math.min(Math.max(Number(limit), 1), 100));
          return `LIMIT $${values.length}`;
        })()
      : "";

    const result = await this.db.query(
      `
      SELECT
        i.audit_log_id AS "auditLogId",
        i.leaf_index AS "leafIndex",
        i.leaf_hash AS "leafHash",
        i.merkle_proof AS "merkleProof"
      FROM audit_batch_items i
      WHERE i.batch_id = $1
      ORDER BY i.leaf_index
      ${limitClause}
      `,
      values,
    );

    return result.rows.map((row) => ({
      ...row,
      merkleProof:
        typeof row.merkleProof === "string"
          ? JSON.parse(row.merkleProof)
          : row.merkleProof,
    }));
  }
  async listAuditLogs(input: {
    tenantId?: string;
    actorType?: string;
    actionType?: string;
    status?: string;
    batchStatus?: string;
    processed?: boolean;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.min(Math.max(Number(input.limit ?? 100), 1), 200);

    const offset = Math.max(Number(input.offset ?? 0), 0);

    const conditions: string[] = [];
    const values: unknown[] = [];

    const addCondition = (condition: string, value: unknown) => {
      values.push(value);

      conditions.push(condition.replace("?", `$${values.length}`));
    };

    if (input.tenantId) {
      addCondition("l.tenant_id = ?::uuid", input.tenantId);
    }

    if (input.actorType) {
      addCondition("l.actor_type = ?", input.actorType);
    }

    if (input.actionType) {
      addCondition("l.action_type = ?", input.actionType);
    }

    if (input.status) {
      addCondition("l.status = ?", input.status);
    }

    if (input.batchStatus) {
      addCondition("b.status = ?", input.batchStatus);
    }

    if (input.processed === true) {
      conditions.push("i.audit_log_id IS NOT NULL");
    }

    if (input.processed === false) {
      conditions.push("i.audit_log_id IS NULL");
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await this.db.query<{
      total: string;
    }>(
      `
      SELECT COUNT(*)::text AS total
      FROM audit_logs l
      LEFT JOIN audit_batch_items i
        ON i.audit_log_id = l.id
      LEFT JOIN audit_batches b
        ON b.id = i.batch_id
      ${where}
      `,
      values,
    );

    const limitPosition = values.length + 1;

    const offsetPosition = values.length + 2;

    const result = await this.db.query(
      `
      SELECT
        l.id,
        l.tenant_id,
        l.workflow_id,

        l.actor_type,
        l.actor_id,
        l.action_type,

        l.resource_type,
        l.resource_id,

        l.status,
        l.description,

        l.fabric_transaction_id,
        l.previous_event_hash,
        l.event_hash,

        l.occurred_at,
        l.recorded_at,

        i.batch_id,
        i.leaf_index,
        i.leaf_hash,

        b.status AS batch_status,
        b.submission_mode,
        b.merkle_root,

        b.hedera_topic_id,
        b.hedera_transaction_id,
        b.hedera_sequence_number,
        b.hedera_consensus_timestamp,

        CASE
          WHEN i.audit_log_id IS NULL
            THEN 'UNPROCESSED'

          WHEN b.status IN (
            'BUILDING',
            'READY',
            'READY_FOR_WALLET'
          )
            THEN 'PROCESSED_LOCALLY'

          WHEN b.status IN (
            'SUBMITTING',
            'SUBMISSION_FAILED',
            'SUBMISSION_UNKNOWN',
            'VERIFICATION_FAILED'
          )
            THEN 'WAITING_FOR_RECOVERY'

          WHEN b.status IN (
            'SUBMITTED',
            'VERIFYING'
          )
            THEN 'WAITING_FOR_CONFIRMATION'

          WHEN b.status = 'CONFIRMED'
            THEN 'CONFIRMED'

          ELSE 'UNKNOWN'
        END AS anchor_status

      FROM audit_logs l

      LEFT JOIN audit_batch_items i
        ON i.audit_log_id = l.id

      LEFT JOIN audit_batches b
        ON b.id = i.batch_id

      ${where}

      ORDER BY
        l.occurred_at DESC,
        l.id DESC

      LIMIT $${limitPosition}
      OFFSET $${offsetPosition}
      `,
      [...values, limit, offset],
    );

    const total = Number(countResult.rows[0]?.total ?? 0);

    return {
      items: result.rows,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + result.rows.length < total,
      },
    };
  }
  async getAuditLogDetails(auditLogId: string) {
    const result = await this.db.query(
      `
    SELECT
      l.*,

      i.batch_id,
      i.leaf_index,
      i.leaf_hash,
      i.merkle_proof,

      b.status AS batch_status,
      b.submission_mode,
      b.payer_account_id,
      b.merkle_root,
      b.event_count,
      b.hedera_topic_id,
      b.hedera_transaction_id,
      b.hedera_sequence_number,
      b.hedera_consensus_timestamp,
      b.submitted_at,
      b.confirmed_at,
      b.processing_completed_at,

      CASE
        WHEN i.audit_log_id IS NULL
          THEN 'UNPROCESSED'
        ELSE b.status
      END AS anchor_status,

      COALESCE(reviews.items, '[]'::json) AS agent_reviews

    FROM audit_logs l

    LEFT JOIN audit_batch_items i
      ON i.audit_log_id = l.id

    LEFT JOIN audit_batches b
      ON b.id = i.batch_id

    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object(
          'id', r.id,
          'reviewer_id', r.reviewer_id,
          'status', r.status,
          'reasoning', r.reasoning,
          'review_created_at', r.review_created_at,
          'review_due_at', r.review_due_at,
          'review_opened_at', r.review_opened_at,
          'review_completed_at', r.review_completed_at
        )
        ORDER BY r.review_created_at
      ) AS items
      FROM agent_reviews r
      WHERE r.agent_log_id = l.id
    ) reviews ON TRUE

    WHERE l.id = $1
    `,
      [auditLogId],
    );

    return result.rows[0] ?? null;
  }
}
