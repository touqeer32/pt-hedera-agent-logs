import {
  Client,
  PrivateKey,
  TopicCreateTransaction,
} from "@hashgraph/sdk";

async function main(): Promise<void> {
  const network =
    process.env.HEDERA_NETWORK ?? "testnet";

  const operatorId =
    process.env.HEDERA_OPERATOR_ID;

  const operatorKeyValue =
    process.env.HEDERA_OPERATOR_KEY;

  if (!operatorId || !operatorKeyValue) {
    throw new Error(
      "HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY are required",
    );
  }

  if (
    network !== "testnet" &&
    network !== "mainnet"
  ) {
    throw new Error(
      "HEDERA_NETWORK must be testnet or mainnet",
    );
  }

  const client =
    network === "mainnet"
      ? Client.forMainnet()
      : Client.forTestnet();

  const operatorKey =
    PrivateKey.fromStringECDSA(
      operatorKeyValue
        .trim()
        .replace(/^0x/, ""),
    );

  console.log(
    "Derived operator public key:",
    operatorKey.publicKey.toStringRaw(),
  );

  client.setOperator(
    operatorId,
    operatorKey,
  );

  try {
    /*
     * No submit key is configured.
     * Any Hedera wallet can submit and pay for
     * a message sent to this topic.
     */
    const response =
      await new TopicCreateTransaction()
        .setTopicMemo(
          `PharmaTrace Audit Anchors - Wallet - ${network}`,
        )
        .execute(client);

    const receipt =
      await response.getReceipt(client);

    if (!receipt.topicId) {
      throw new Error(
        "Hedera did not return a topic ID",
      );
    }

    console.log("");
    console.log(
      "Wallet-enabled HCS topic created",
    );
    console.log("");
    console.log(
      `HEDERA_NETWORK=${network}`,
    );
    console.log(
      `HEDERA_TOPIC_ID=${receipt.topicId.toString()}`,
    );
    console.log("");
    console.log(
      "This topic has no submit key.",
    );
    console.log(
      "Connected UI wallets can sign, pay and submit messages.",
    );
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Failed to create wallet-enabled HCS topic:",
    error,
  );

  process.exitCode = 1;
});