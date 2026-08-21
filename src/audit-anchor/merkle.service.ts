import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
const sha = (hex: string) =>
  createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
@Injectable()
export class MerkleService {
  build(leaves: string[]) {
    if (!leaves.length) throw new Error("Cannot build an empty Merkle tree");
    for (const x of leaves)
      if (!/^[0-9a-f]{64}$/i.test(x))
        throw new Error(`Invalid event hash: ${x}`);
    const proofs: string[][] = leaves.map(() => []);
    let level = leaves.map((x) => x.toLowerCase());
    let owners = leaves.map((_, i) => [i]);
    while (level.length > 1) {
      const next: string[] = [];
      const nextOwners: number[][] = [];
      for (let i = 0; i < level.length; i += 2) {
        const l = level[i],
          r = level[i + 1] ?? l;
        for (const n of owners[i]) proofs[n].push(`R:${r}`);
        if (owners[i + 1])
          for (const n of owners[i + 1]) proofs[n].push(`L:${l}`);
        next.push(sha(l + r));
        nextOwners.push([...owners[i], ...(owners[i + 1] ?? [])]);
      }
      level = next;
      owners = nextOwners;
    }
    return { root: level[0], proofs };
  }
  verify(leafHash: string, proof: string[], expectedRoot: string): boolean {
    if (
      !/^[0-9a-f]{64}$/i.test(leafHash) ||
      !/^[0-9a-f]{64}$/i.test(expectedRoot)
    ) {
      return false;
    }

    let currentHash = leafHash.toLowerCase();

    for (const proofItem of proof) {
      const [direction, siblingHash] = proofItem.split(":", 2);

      if (
        (direction !== "L" && direction !== "R") ||
        !/^[0-9a-f]{64}$/i.test(siblingHash)
      ) {
        return false;
      }

      const combined =
        direction === "L"
          ? siblingHash.toLowerCase() + currentHash
          : currentHash + siblingHash.toLowerCase();

      currentHash = createHash("sha256")
        .update(Buffer.from(combined, "hex"))
        .digest("hex");
    }

    return currentHash === expectedRoot.toLowerCase();
  }
}
