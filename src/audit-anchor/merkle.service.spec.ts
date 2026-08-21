import { createHash } from "crypto";
import { MerkleService } from "./merkle.service";

import { ConfigService } from "@nestjs/config";
import { AuditAnchorService } from "./audit-anchor.service";
import { SubmissionFailedError } from "./hedera.service";
import { BatchRow, SubmissionUnknownError } from "./types";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const walletBatch: BatchRow = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  merkle_root: "a".repeat(64),
  event_count: 3,
  hedera_sequence_number: null,
  hedera_topic_id: null,
  hedera_transaction_id: null,
  hedera_consensus_timestamp: null,
  wallet_transaction_bytes: null,
  payer_account_id: "0.0.1234",
  submission_mode: "WALLET",
  status: "READY_FOR_WALLET",
  attempt_count: 0,
  last_attempt_at: null,
  next_retry_at: null,
  processing_started_at: new Date(),
  processing_completed_at: null,
};

describe("AuditAnchorService wallet anchoring", () => {
  function setup(batch: BatchRow = walletBatch) {
    const db = { query: jest.fn(), connect: jest.fn() };
    const config = new ConfigService({
      BATCH_MAX_EVENTS: 1000,
      MAX_BATCHES_PER_RUN: 10,
    });
    const batches = {
      createNext: jest
        .fn()
        .mockResolvedValueOnce(batch.id)
        .mockResolvedValueOnce(null),

      get: jest.fn().mockResolvedValue(batch),
      setStatus: jest.fn().mockResolvedValue(undefined),
      beginSubmissionAttempt: jest.fn().mockResolvedValue(undefined),
      markSubmitted: jest.fn().mockResolvedValue(undefined),
      markSubmissionFailed: jest.fn().mockResolvedValue(undefined),
      markSubmissionUnknown: jest.fn().mockResolvedValue(undefined),
      markReadyForWallet: jest.fn().mockResolvedValue(undefined),
      markWalletSubmitted: jest.fn().mockResolvedValue(undefined),
      getBatchItems: jest.fn().mockResolvedValue([]),
      markConfirmed: jest.fn().mockResolvedValue(undefined),
    };
    const hedera = {
      validateWalletPreparation: jest.fn(),
      prepareWalletTransaction: jest.fn().mockResolvedValue({
        topicId: "0.0.99",
        transactionId: "0.0.1234@123.456",
        transactionBytes: "signed-bytes",
      }),
      submit: jest.fn(),
    };
    const merkle = {
      verify: jest.fn(),
    };
    const mirror = { verifyWalletTransaction: jest.fn() };
    const service = new AuditAnchorService(
      db as never,
      config,
      batches as never,
      hedera as never,
      mirror as never,
      merkle as never,
    );
    return { service, batches, hedera, mirror };
  }

  it("uses the committed stored root when preparing the wallet transaction", async () => {
    const { service, batches, hedera } = setup();

    const result = await service.prepareWalletBatches({
      payerAccountId: "0.0.1234",
      maxEvents: 10,
    });

    expect(batches.createNext).toHaveBeenCalledWith(
      undefined,
      10,
      "WALLET",
      "0.0.1234",
    );
    expect(hedera.prepareWalletTransaction).toHaveBeenCalledWith({
      batchId: walletBatch.id,

      merkleRoot: walletBatch.merkle_root,

      payerAccountId: "0.0.1234",
    });
    expect(result.eventCount).toBe(3);
    expect(result.merkleRoot).toBe(walletBatch.merkle_root);
  });

  it("regenerates transaction bytes without creating a replacement batch", async () => {
    const { service, batches, hedera } = setup();

    await service.prepareWalletTransaction(walletBatch.id, "0.0.1234");

    expect(batches.createNext).not.toHaveBeenCalled();
    expect(hedera.prepareWalletTransaction).toHaveBeenCalledWith({
      batchId: walletBatch.id,

      merkleRoot: walletBatch.merkle_root,

      payerAccountId: "0.0.1234",
    });
    expect(batches.markReadyForWallet).toHaveBeenCalledWith(walletBatch.id, {
      topicId: "0.0.99",
      payerAccountId: "0.0.1234",

      transactionBytes: "signed-bytes",
    });
  });
  it("records the exact prepared wallet transaction", async () => {
    const submittedBatch: BatchRow = {
      ...walletBatch,

      hedera_topic_id: "0.0.99",

      hedera_transaction_id: "0.0.1234@123.456",
    };

    const { service, batches } = setup(submittedBatch);

    jest.spyOn(service, "verifyWalletBatch").mockResolvedValue(undefined);

    const result = await service.recordWalletSubmission(submittedBatch.id, {
      transactionId: "0.0.1234@123.456",
      topicId: "0.0.99",
      sequenceNumber: "10",
      consensusTimestamp: "123.789",
    });

    expect(batches.markWalletSubmitted).toHaveBeenCalledWith(submittedBatch.id, {
      transactionId: "0.0.1234@123.456",
      topicId: "0.0.99",
      sequenceNumber: "10",
      consensusTimestamp: "123.789",
    });

    expect(result).toEqual({
      accepted: true,
      batchId: submittedBatch.id,
      status: "SUBMITTED",
    });
  });
  it("accepts the wallet transaction ID when the wallet assigns a new valid start time", async () => {
    const preparedBatch: BatchRow = {
      ...walletBatch,

      hedera_topic_id: "0.0.99",

      hedera_transaction_id: "0.0.1234@123.456",
    };

    const { service, batches } = setup(preparedBatch);

    await expect(
      service.recordWalletSubmission(preparedBatch.id, {
        transactionId: "0.0.1234@999.999",
        topicId: "0.0.99",
        sequenceNumber: "10",
        consensusTimestamp: "123.789",
      }),
    ).resolves.toEqual({
      accepted: true,
      batchId: preparedBatch.id,
      status: "SUBMITTED",
    });

    expect(batches.markWalletSubmitted).toHaveBeenCalled();
  });
  it("rejects a prepared transaction with the wrong payer", async () => {
    const preparedBatch: BatchRow = {
      ...walletBatch,

      payer_account_id: "0.0.1234",

      hedera_transaction_id: "0.0.9999@123.456",
    };

    const { service, batches } = setup(preparedBatch);

    await expect(
      service.recordWalletSubmission(preparedBatch.id, {
        transactionId: "0.0.9999@123.456",
        topicId: "0.0.99",
        sequenceNumber: "10",
        consensusTimestamp: "123.789",
      }),
    ).rejects.toThrow("Transaction payer does not match the prepared wallet");

    expect(batches.markWalletSubmitted).not.toHaveBeenCalled();
  });
  it("stores Mirror Node confirmation and processing completion together", async () => {
    const submitted: BatchRow = {
      ...walletBatch,
      status: "SUBMITTED",
      hedera_topic_id: "0.0.99",
      hedera_transaction_id: "0.0.1234@123.456",
    };
    const { service, batches, mirror } = setup(submitted);
    mirror.verifyWalletTransaction.mockResolvedValue({
      sequenceNumber: "7",
      consensusTimestamp: "123.789",
    });

    await service.verifyWalletBatch(submitted.id);

    expect(batches.setStatus).toHaveBeenLastCalledWith(
      submitted.id,
      "CONFIRMED",
      expect.objectContaining({
        hedera_sequence_number: "7",
        hedera_consensus_timestamp: "123.789",
        confirmed_at: expect.any(Date),
        processing_completed_at: expect.any(Date),
      }),
    );
  });

  it("keeps the same stored batch and root when a submission result is unknown", async () => {
    const serviceBatch: BatchRow = {
      ...walletBatch,
      submission_mode: "SERVICE",
      status: "READY",
      payer_account_id: null,
    };
    const { service, batches, hedera } = setup(serviceBatch);
    hedera.submit.mockRejectedValue(
      new SubmissionUnknownError("timed out", "0.0.10@123.456"),
    );

    await service.retryStoredBatch(serviceBatch.id);

    expect(hedera.submit).toHaveBeenCalledWith({
      batchId: serviceBatch.id,
      merkleRoot: serviceBatch.merkle_root,
    });
    expect(batches.createNext).not.toHaveBeenCalled();
    expect(batches.markSubmissionUnknown).toHaveBeenCalledWith(
      serviceBatch.id,
      expect.any(SubmissionUnknownError),
      expect.any(Date),
      "0.0.10@123.456",
    );
  });

  it("marks a definite rejection failed without generating another batch", async () => {
    const serviceBatch: BatchRow = {
      ...walletBatch,
      submission_mode: "SERVICE",
      status: "READY",
      payer_account_id: null,
    };
    const { service, batches, hedera } = setup(serviceBatch);
    hedera.submit.mockRejectedValue(
      new SubmissionFailedError("INVALID_SIGNATURE"),
    );

    await service.retryStoredBatch(serviceBatch.id);

    expect(batches.markSubmissionFailed).toHaveBeenCalledWith(
      serviceBatch.id,
      expect.any(SubmissionFailedError),
      expect.any(Date),
    );
    expect(batches.createNext).not.toHaveBeenCalled();
  });
});

describe("MerkleService", () => {
  let service: MerkleService;

  beforeEach(() => {
    service = new MerkleService();
  });

  it("uses the supplied event hashes as leaf hashes", () => {
    const eventHashes = [
      sha256("event-1"),
      sha256("event-2"),
      sha256("event-3"),
    ];

    const result = service.build(eventHashes);

    /*
     * MerkleService must not change or recalculate the
     * event hashes before using them as leaves.
     */
    expect(eventHashes).toEqual([
      sha256("event-1"),
      sha256("event-2"),
      sha256("event-3"),
    ]);

    expect(result.root).toMatch(/^[0-9a-f]{64}$/);

    expect(result.proofs).toHaveLength(eventHashes.length);
  });

  it("produces the same root when retrying a batch", () => {
    const storedLeafHashes = [
      sha256("event-1"),
      sha256("event-2"),
      sha256("event-3"),
      sha256("event-4"),
    ];

    const firstAttempt = service.build(storedLeafHashes);

    const retryAttempt = service.build(storedLeafHashes);

    expect(retryAttempt.root).toBe(firstAttempt.root);

    expect(retryAttempt.proofs).toEqual(firstAttempt.proofs);
  });

  it("handles an odd number of leaves deterministically", () => {
    const leaves = [sha256("event-1"), sha256("event-2"), sha256("event-3")];

    const first = service.build(leaves);
    const second = service.build(leaves);

    expect(second.root).toBe(first.root);
    expect(second.proofs).toEqual(first.proofs);

    expect(first.proofs).toHaveLength(3);
  });

  it("rejects an empty tree", () => {
    expect(() => service.build([])).toThrow(
      "Cannot build an empty Merkle tree",
    );
  });

  it("rejects invalid event hashes", () => {
    expect(() => service.build(["not-a-sha256-hash"])).toThrow(
      "Invalid event hash",
    );
  });
});
