import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  FindBatchMessageInput,
  MirrorMessageDetails,
  MirrorNodeLookupResult,
  VerifyMirrorMessageInput,
  VerifyWalletTransactionInput,
  WalletMirrorVerification,
} from "./types";
interface MirrorNodeMessageResponse {
  consensus_timestamp: string;
  message: string;
  sequence_number: number;
  topic_id: string;

  payer_account_id?: string;

  chunk_info?: {
    initial_transaction_id?: {
      account_id?: string;
      transaction_valid_start?: string;
      nonce?: number;
      scheduled?: boolean;
    };
  };
}

interface MirrorNodeTransaction {
  transaction_id: string;
  consensus_timestamp: string;
  result: string;

  /*
   * For a topic-message transaction, entity_id
   * should contain the topic ID.
   */
  entity_id?: string;
}

interface MirrorNodeTransactionsResponse {
  transactions?: MirrorNodeTransaction[];
}

interface MirrorNodeMessagesResponse {
  messages: MirrorNodeMessageResponse[];

  links?: {
    next?: string | null;
  };
}

@Injectable()
export class MirrorNodeService {
  constructor(private readonly config: ConfigService) {}

  async verifyBySequence(
    input: VerifyMirrorMessageInput,
  ): Promise<MirrorNodeLookupResult> {
    const url =
      `${this.baseUrl()}/api/v1/topics/` +
      `${input.topicId}/messages/` +
      `${input.sequenceNumber}`;

    const response = await fetch(url);

    if (response.status === 404) {
      return {
        status: "NOT_FOUND",
        reason: "NOT_INDEXED",
      };
    }

    if (!response.ok) {
      throw new Error(`Mirror Node returned HTTP ${response.status}`);
    }

    const message = (await response.json()) as MirrorNodeMessageResponse;

    const decoded = this.decodeMessage(message);

    if (
      decoded.batchId !== input.batchId ||
      decoded.merkleRoot !== input.merkleRoot
    ) {
      throw new Error(
        `Mirror Node message does not match batch ${input.batchId}`,
      );
    }

    return this.toFoundResult(message, decoded);
  }

  async findBatchMessage(
    input: FindBatchMessageInput,
  ): Promise<MirrorNodeLookupResult> {
    let nextUrl: string | null =
      `${this.baseUrl()}/api/v1/topics/` +
      `${input.topicId}/messages` +
      "?limit=100&order=desc";

    const maximumPages = Number(this.config.get("MIRROR_SEARCH_MAX_PAGES", 10));

    for (let page = 0; nextUrl && page < maximumPages; page++) {
      const response = await fetch(nextUrl);

      if (response.status === 404) {
        return {
          status: "NOT_FOUND",
          reason: "NOT_INDEXED",
        };
      }

      if (!response.ok) {
        throw new Error(`Mirror Node search returned HTTP ${response.status}`);
      }

      const body = (await response.json()) as MirrorNodeMessagesResponse;

      for (const message of body.messages ?? []) {
        if (
          input.payerAccountId &&
          message.payer_account_id &&
          message.payer_account_id !== input.payerAccountId
        ) {
          continue;
        }

        let decoded: MirrorMessageDetails;

        try {
          decoded = this.decodeMessage(message);
        } catch {
          // The topic can contain unrelated message formats.
          continue;
        }

        if (
          decoded.batchId === input.batchId &&
          decoded.merkleRoot === input.merkleRoot
        ) {
          return this.toFoundResult(message, decoded);
        }
      }

      nextUrl = this.resolveNextUrl(body.links?.next ?? null);
    }

    return {
      status: "NOT_FOUND",
      reason: "SEARCH_COMPLETED",
    };
  }

  private decodeMessage(
    message: MirrorNodeMessageResponse,
  ): MirrorMessageDetails {
    const decoded = JSON.parse(
      Buffer.from(message.message, "base64").toString("utf8"),
    ) as Partial<MirrorMessageDetails>;

    if (
      typeof decoded.batchId !== "string" ||
      typeof decoded.merkleRoot !== "string"
    ) {
      throw new Error("HCS message does not contain a valid batch reference");
    }

    return {
      version: Number(decoded.version ?? 1),
      batchId: decoded.batchId,
      merkleRoot: decoded.merkleRoot,
      hashAlgorithm: decoded.hashAlgorithm ?? "SHA-256",
    };
  }

  private toFoundResult(
    message: MirrorNodeMessageResponse,
    decoded: MirrorMessageDetails,
  ): MirrorNodeLookupResult {
    return {
      status: "FOUND",
      topicId: message.topic_id,
      sequenceNumber: message.sequence_number.toString(),
      consensusTimestamp: message.consensus_timestamp,
      transactionId: this.extractTransactionId(message),
      message: decoded,
    };
  }

  private extractTransactionId(
    message: MirrorNodeMessageResponse,
  ): string | undefined {
    const transaction = message.chunk_info?.initial_transaction_id;

    if (!transaction?.account_id || !transaction.transaction_valid_start) {
      return undefined;
    }

    return `${transaction.account_id}@` + transaction.transaction_valid_start;
  }

  private resolveNextUrl(next: string | null): string | null {
    if (!next) {
      return null;
    }

    if (next.startsWith("http")) {
      return next;
    }

    return `${this.baseUrl()}${next}`;
  }

  private baseUrl(): string {
    return this.config
      .get("MIRROR_NODE_URL", "https://testnet.mirrornode.hedera.com")
      .replace(/\/$/, "");
  }
  async verifyWalletTransaction(
    input: VerifyWalletTransactionInput,
  ): Promise<WalletMirrorVerification | null> {
    /*
     * Application transaction IDs use:
     *
     * 0.0.1234@1234567890.123456789
     *
     * Mirror Node path IDs use:
     *
     * 0.0.1234-1234567890-123456789
     */
    const mirrorTransactionId = this.toMirrorTransactionId(input.transactionId);

    const transactionUrl =
      `${this.baseUrl()}/api/v1/transactions/` +
      encodeURIComponent(mirrorTransactionId);

    const transactionResponse = await fetch(transactionUrl);

    if (transactionResponse.status === 404) {
      /*
       * The wallet can submit with a new valid-start time, so the callback
       * may contain the prepared ID instead of the actual submitted ID.
       */
      return this.findWalletBatchMessage(input);
    }

    if (!transactionResponse.ok) {
      throw new Error(
        "Mirror Node transaction lookup " +
          `returned HTTP ${transactionResponse.status}`,
      );
    }

    const transactionBody =
      (await transactionResponse.json()) as MirrorNodeTransactionsResponse;

    const transaction = transactionBody.transactions?.find(
      (candidate) =>
        this.normalizeTransactionId(candidate.transaction_id) ===
        this.normalizeTransactionId(input.transactionId),
    );

    if (!transaction) {
      return this.findWalletBatchMessage(input);
    }

    if (transaction.result !== "SUCCESS") {
      throw new Error("Hedera transaction result is " + transaction.result);
    }

    if (transaction.entity_id && transaction.entity_id !== input.topicId) {
      throw new Error("Transaction topic does not match the configured topic");
    }

    /*
     * Find the HCS message created by this exact
     * transaction consensus timestamp.
     */
    const messageUrl =
      `${this.baseUrl()}/api/v1/topics/` +
      `${input.topicId}/messages` +
      "?timestamp=eq:" +
      encodeURIComponent(transaction.consensus_timestamp) +
      "&limit=1";

    const messageResponse = await fetch(messageUrl);

    if (messageResponse.status === 404) {
      return null;
    }

    if (!messageResponse.ok) {
      throw new Error(
        "Mirror Node message lookup " +
          `returned HTTP ${messageResponse.status}`,
      );
    }

    const messageBody =
      (await messageResponse.json()) as MirrorNodeMessagesResponse;

    const message = messageBody.messages?.find(
      (candidate) =>
        candidate.consensus_timestamp === transaction.consensus_timestamp,
    );

    if (!message) {
      /*
       * Transaction is indexed but the topic message
       * may still be unavailable.
       */
      return null;
    }

    if (message.topic_id !== input.topicId) {
      throw new Error("HCS message topic does not match the configured topic");
    }

    if (
      message.payer_account_id &&
      message.payer_account_id !== input.payerAccountId
    ) {
      throw new Error("HCS payer does not match the prepared wallet");
    }

    const decoded = this.decodeMessage(message);

    if (
      decoded.batchId !== input.batchId ||
      decoded.merkleRoot !== input.merkleRoot
    ) {
      throw new Error(
        "HCS message does not match the stored batch and Merkle root",
      );
    }

    return {
      topicId: message.topic_id,
      transactionId: input.transactionId,
      payerAccountId: input.payerAccountId,
      sequenceNumber: message.sequence_number.toString(),
      consensusTimestamp: message.consensus_timestamp,
      message: decoded,
    };
  }
  private async findWalletBatchMessage(
    input: VerifyWalletTransactionInput,
  ): Promise<WalletMirrorVerification | null> {
    const result = await this.findBatchMessage({
      topicId: input.topicId,
      batchId: input.batchId,
      merkleRoot: input.merkleRoot,
      payerAccountId: input.payerAccountId,
    });

    if (result.status !== "FOUND") {
      return null;
    }

    return {
      topicId: result.topicId,
      transactionId: result.transactionId,
      payerAccountId: input.payerAccountId,
      sequenceNumber: result.sequenceNumber,
      consensusTimestamp: result.consensusTimestamp,
      message: result.message,
    };
  }
  private toMirrorTransactionId(transactionId: string): string {
    const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(transactionId);

    if (!match) {
      throw new Error("Invalid Hedera transaction ID");
    }

    return `${match[1]}-` + `${match[2]}-` + match[3];
  }
  private normalizeTransactionId(transactionId: string): string {
    const applicationFormat = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(
      transactionId,
    );

    if (applicationFormat) {
      return (
        `${applicationFormat[1]}-` +
        `${applicationFormat[2]}-` +
        applicationFormat[3]
      );
    }

    return transactionId;
  }
}
