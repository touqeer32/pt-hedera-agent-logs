import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AccountId,
  Client,
  PrecheckStatusError,
  PrivateKey,
  ReceiptStatusError,
  TopicMessageSubmitTransaction,
  TransactionId,
} from "@hashgraph/sdk";

import {
  PreparedWalletTransaction,
  HederaSubmissionReceipt,
  SubmissionUnknownError,
} from "./types";
export interface SubmitBatchInput {
  batchId: string;
  merkleRoot: string;
}

export class SubmissionFailedError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SubmissionFailedError";
  }
}

@Injectable()
export class HederaService {
  constructor(private readonly config: ConfigService) {}

  async submit(input: SubmitBatchInput): Promise<HederaSubmissionReceipt> {
    const network = this.config.get("HEDERA_NETWORK", "testnet");

    const client =
      network === "mainnet" ? Client.forMainnet() : Client.forTestnet();

    const operatorId = this.config.getOrThrow<string>("HEDERA_OPERATOR_ID");

    const operatorKeyValue = this.config.getOrThrow<string>(
      "HEDERA_OPERATOR_KEY",
    );

    const operatorKey = PrivateKey.fromStringECDSA(
      operatorKeyValue.trim().replace(/^0x/, ""),
    );

    client.setOperator(operatorId, operatorKey);

    const topicId = this.config.getOrThrow<string>("HEDERA_TOPIC_ID");
    let transactionId: string | undefined;

    try {
      const message = Buffer.from(
        JSON.stringify({
          version: 1,
          batchId: input.batchId,
          merkleRoot: input.merkleRoot,
          hashAlgorithm: "SHA-256",
        }),
      );

      const submitKeyValue = this.config.getOrThrow<string>(
        "HEDERA_TOPIC_SUBMIT_KEY",
      );

      const submitKey = PrivateKey.fromStringED25519(
        submitKeyValue.trim().replace(/^0x/, ""),
      );

      let transaction = new TopicMessageSubmitTransaction()
        .setTopicId(topicId)
        .setMessage(message)
        .freezeWith(client);

      transaction = await transaction.sign(submitKey);

      const response = await transaction.execute(client);

      transactionId = response.transactionId.toString();

      /*
       * The network may already have accepted the transaction.
       * A failure after execute() is therefore uncertain unless
       * a receipt explicitly reports failure.
       */
      const receipt = await response.getReceipt(client);

      if (!receipt.topicSequenceNumber) {
        throw new SubmissionUnknownError(
          "Hedera returned no topic sequence number",
          transactionId,
        );
      }

      return {
        topicId,
        transactionId,
        sequenceNumber: receipt.topicSequenceNumber.toString(),
      };
    } catch (error) {
      if (
        error instanceof SubmissionFailedError ||
        error instanceof SubmissionUnknownError
      ) {
        throw error;
      }

      /*
       * Precheck means the transaction was rejected before
       * consensus submission.
       */
      if (error instanceof PrecheckStatusError) {
        throw new SubmissionFailedError(
          `Hedera precheck rejected the transaction: ${error.message}`,
          error,
        );
      }

      /*
       * ReceiptStatusError means a consensus receipt was
       * obtained and reported failure.
       */
      if (error instanceof ReceiptStatusError) {
        throw new SubmissionFailedError(
          `Hedera receipt reported failure: ${error.message}`,
          error,
        );
      }

      /*
       * Timeout, socket failure, DNS failure or interrupted
       * response can happen after Hedera accepted the message.
       */
      throw new SubmissionUnknownError(
        `Hedera submission result is unknown: ${
          error instanceof Error ? error.message : String(error)
        }`,
        transactionId,
        error,
      );
    } finally {
      client.close();
    }
  }
  private getTopicSubmitKey(): PrivateKey {
    const value = this.config.getOrThrow<string>("HEDERA_TOPIC_SUBMIT_KEY");

    const keyType = this.config
      .get<string>("HEDERA_TOPIC_SUBMIT_KEY_TYPE", "ED25519")
      .toUpperCase();

    const normalized = value.trim().replace(/^0x/, "");

    if (keyType === "ED25519") {
      return PrivateKey.fromStringED25519(normalized);
    }

    if (keyType === "ECDSA") {
      return PrivateKey.fromStringECDSA(normalized);
    }

    if (keyType === "DER") {
      return PrivateKey.fromStringDer(normalized);
    }

    throw new Error(
      "HEDERA_TOPIC_SUBMIT_KEY_TYPE must be ED25519, ECDSA, or DER",
    );
  }
  async prepareWalletTransaction(
    input: {
      batchId: string;
      merkleRoot: string;
      payerAccountId: string;
      transactionId?: string;
    },
  ): Promise<PreparedWalletTransaction> {
    this.validateWalletPreparation(input.payerAccountId);

    const network = this.config.get("HEDERA_NETWORK", "testnet");

    const client =
      network === "mainnet" ? Client.forMainnet() : Client.forTestnet();

    try {
      const topicId = this.config.getOrThrow<string>("HEDERA_TOPIC_ID");

      const payerAccount = AccountId.fromString(input.payerAccountId);

      const message = Buffer.from(
        JSON.stringify({
          version: 1,
          batchId: input.batchId,
          merkleRoot: input.merkleRoot,
          hashAlgorithm: "SHA-256",
        }),
      );

      const transaction = await new TopicMessageSubmitTransaction()
        .setTopicId(topicId)
        .setMessage(message)
        .setTransactionId(
          input.transactionId
            ? TransactionId.fromString(input.transactionId)
            : TransactionId.generate(payerAccount),
        )
        .freezeWith(client);

      return {
        batchId: input.batchId,
        topicId,
        payerAccountId: input.payerAccountId,
        transactionId: transaction.transactionId!.toString(),
        transactionBytes: Buffer.from(transaction.toBytes()).toString("base64"),
      };
    } finally {
      client.close();
    }
  }
  validateWalletPreparation(payerAccountId: string): void {
    AccountId.fromString(payerAccountId);

    this.config.getOrThrow<string>("HEDERA_TOPIC_ID");

    const network = this.config.get("HEDERA_NETWORK", "testnet");

    if (network !== "testnet" && network !== "mainnet") {
      throw new Error("HEDERA_NETWORK must be testnet or mainnet");
    }
  }
}
