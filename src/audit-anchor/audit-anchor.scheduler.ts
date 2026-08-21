import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { AuditAnchorService } from "./audit-anchor.service";
import { ReconciliationService } from "./reconciliation.service";
@Injectable()
export class AuditAnchorScheduler {
  constructor(
    private readonly config: ConfigService,
    private readonly anchor: AuditAnchorService,
    private readonly reconciliation: ReconciliationService,
  ) {}
  @Cron(process.env.ANCHOR_CRON ?? "0 */10 * * * *") async auto() {
    if (!["auto", "both"].includes(this.config.get("ANCHOR_MODE", "manual")))
      return;
    const id = await this.anchor.createJob("AUTO");
    await this.anchor.runSync("AUTO", { jobId: id });
  }
  @Cron(process.env.RECONCILIATION_CRON ?? "0 */3 * * * *") async reconcile() {
    await this.reconciliation.run();
  }
}
