"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const sdk_1 = require("@hashgraph/sdk");
async function main() {
    const network = process.env.HEDERA_NETWORK ?? "testnet";
    const operatorId = process.env.HEDERA_OPERATOR_ID;
    const operatorKeyValue = process.env.HEDERA_OPERATOR_KEY;
    if (!operatorId || !operatorKeyValue) {
        throw new Error("HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY are required");
    }
    if (network !== "testnet" && network !== "mainnet") {
        throw new Error("HEDERA_NETWORK must be testnet or mainnet");
    }
    const client = network === "mainnet" ? sdk_1.Client.forMainnet() : sdk_1.Client.forTestnet();
    const operatorKeyType = process.env.HEDERA_OPERATOR_KEY_TYPE?.toUpperCase();
    const operatorKey = sdk_1.PrivateKey.fromStringECDSA(operatorKeyValue.trim().replace(/^0x/, ""));
    //   if (operatorKeyType === "ECDSA") {
    //     operatorKey = PrivateKey.fromStringECDSA(
    //       operatorKeyValue.trim().replace(/^0x/, ""),
    //     );
    //   } else if (operatorKeyType === "ED25519") {
    //     operatorKey = PrivateKey.fromStringED25519(
    //       operatorKeyValue.trim().replace(/^0x/, ""),
    //     );
    //   } else if (operatorKeyType === "DER") {
    //     operatorKey = PrivateKey.fromStringDer(
    //       operatorKeyValue.trim().replace(/^0x/, ""),
    //     );
    //   } else {
    //     throw new Error("HEDERA_OPERATOR_KEY_TYPE must be ECDSA, ED25519, or DER");
    //   }
    console.log("Derived operator public key:", operatorKey.publicKey.toStringRaw());
    client.setOperator(operatorId, operatorKey);
    /*
     * Generate a separate key that controls who may submit
     * messages to this topic.
     */
    const submitKey = sdk_1.PrivateKey.generateED25519();
    try {
        const transaction = await new sdk_1.TopicCreateTransaction()
            .setTopicMemo(`PharmaTrace Audit Anchors - ${network}`)
            .setSubmitKey(submitKey.publicKey)
            .execute(client);
        const receipt = await transaction.getReceipt(client);
        if (!receipt.topicId) {
            throw new Error("Hedera did not return a topic ID");
        }
        console.log("");
        console.log("Protected HCS topic created");
        console.log("");
        console.log(`HEDERA_NETWORK=${network}`);
        console.log(`HEDERA_TOPIC_ID=${receipt.topicId.toString()}`);
        console.log(`HEDERA_TOPIC_SUBMIT_KEY=${submitKey.toString()}`);
        console.log("");
        console.log("Save HEDERA_TOPIC_SUBMIT_KEY in Vault or a Kubernetes Secret.");
        console.log("Do not commit the submit private key to Git.");
    }
    finally {
        client.close();
    }
}
main().catch((error) => {
    console.error("Failed to create protected HCS topic:", error);
    process.exitCode = 1;
});
//# sourceMappingURL=create-hedera-topic.js.map