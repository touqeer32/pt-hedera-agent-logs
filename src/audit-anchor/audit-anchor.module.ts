import { Module } from "@nestjs/common";
import { AuditAnchorController } from "./audit-anchor.controller";
import { AuditAnchorService } from "./audit-anchor.service";
import { AuditAnchorScheduler } from "./audit-anchor.scheduler";
import { BatchService } from "./batch.service";
import { HederaService } from "./hedera.service";
import { MerkleService } from "./merkle.service";
import { MirrorNodeService } from "./mirror-node.service";
import { PlatformAdminGuard } from "./platform-admin.guard";
import { ReconciliationService } from "./reconciliation.service";
@Module({
  controllers: [AuditAnchorController],
  providers: [
    AuditAnchorService,
    AuditAnchorScheduler,
    BatchService,
    HederaService,
    MerkleService,
    MirrorNodeService,
    PlatformAdminGuard,
    ReconciliationService,
  ],
})
export class AuditAnchorModule {}
