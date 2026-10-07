import {
  Client,
  PrivateKey,
  TopicCreateTransaction,
} from "@hashgraph/sdk";

type HederaNetwork = "testnet" | "mainnet";
type HederaKeyType = "ECDSA" | "ED25519";

async function verifyOperatorKey(
  network: HederaNetwork,
  operatorId: string,
  operatorKey: PrivateKey,
): Promise<void> {
  const mirrorNode = `https://${network}.mirrornode.hedera.com`;
  const response = await fetch(
    `${mirrorNode}/api/v1/accounts/${encodeURIComponent(operatorId)}`,
  );

  if (!response.ok) {
    throw new Error(
      `Unable to verify operator account ${operatorId} on ${network} Mirror Node ` +
      `(HTTP ${response.status})`,
    );
  }

  const account = await response.json() as {
    key?: { _type?: string; key?: string };
  };
  const registeredKey = account.key?.key?.replace(/^0x/, "").toLowerCase();
  const derivedKey = operatorKey.publicKey.toStringRaw().toLowerCase();

  if (!registeredKey) {
    throw new Error(`Main account ${operatorId} has no readable public key on Mirror Node`);
  }

  if (registeredKey !== derivedKey) {
    throw new Error(
      `Operator private key does not match ${operatorId} on ${network}. ` +
      `Registered public key: ${registeredKey}; derived public key: ${derivedKey}`,
    );
  }

  console.log(`Operator key verified against ${mirrorNode}`);
}

async function main(): Promise<void> {
  const network = (process.env.HEDERA_NETWORK ?? "testnet").toLowerCase() as HederaNetwork;

  if (network !== "testnet" && network !== "mainnet") {
    throw new Error("HEDERA_NETWORK must be testnet or mainnet");
  }

  // Network-specific variables are preferred so a Mainnet key cannot be
  // accidentally used while creating a Testnet topic (or vice versa).
  const prefix = network.toUpperCase();
  const operatorId =
    process.env[`HEDERA_${prefix}_OPERATOR_ID`] ??
    process.env.HEDERA_OPERATOR_ID;
  const operatorKeyValue =
    process.env[`HEDERA_${prefix}_OPERATOR_KEY`] ??
    process.env.HEDERA_OPERATOR_KEY;
  const keyType = (
    process.env[`HEDERA_${prefix}_OPERATOR_KEY_TYPE`] ??
    process.env.HEDERA_OPERATOR_KEY_TYPE ??
    "ECDSA"
  ).toUpperCase() as HederaKeyType;

  if (!operatorId || !operatorKeyValue) {
    throw new Error(
      `Set HEDERA_${prefix}_OPERATOR_ID and HEDERA_${prefix}_OPERATOR_KEY ` +
      `(or the generic HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY)`,
    );
  }

  if (keyType !== "ECDSA" && keyType !== "ED25519") {
    throw new Error("HEDERA_OPERATOR_KEY_TYPE must be ECDSA or ED25519");
  }

  const client =
    network === "mainnet"
      ? Client.forMainnet()
      : Client.forTestnet();

  const normalizedKey = operatorKeyValue.trim().replace(/^0x/, "");
  const operatorKey = keyType === "ED25519"
    ? PrivateKey.fromStringED25519(normalizedKey)
    : PrivateKey.fromStringECDSA(normalizedKey);

  console.log(
    `Creating an open HCS topic on ${network}`,
  );
  console.log("Operator account:", operatorId);
  console.log("Operator key type:", keyType);
  console.log(
    "Derived operator public key:",
    operatorKey.publicKey.toStringRaw(),
  );

  if (process.env.HEDERA_SKIP_OPERATOR_KEY_PREFLIGHT !== "true") {
    await verifyOperatorKey(network, operatorId, operatorKey);
  }

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
    console.log(
      `MIRROR_NODE_URL=https://${network}.mirrornode.hedera.com`,
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
