import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
  Query,
  HttpStatus,
} from "@nestjs/common";
import { AuditAnchorService } from "./audit-anchor.service";
import { BatchService } from "./batch.service";
import { PlatformAdminGuard } from "./platform-admin.guard";
@Controller("audit-anchor")
@UseGuards(PlatformAdminGuard)
export class AuditAnchorController {
  constructor(
    private readonly anchor: AuditAnchorService,
    private readonly batches: BatchService,
  ) {}
  @Post("sync") @HttpCode(202) async sync(
    @Body() body: { tenantId?: string; maxEvents?: number } = {},
  ) {
    const jobId = await this.anchor.createJob("MANUAL", body);
    this.anchor.start(jobId, "MANUAL", body);
    return { jobId, status: "QUEUED" };
  }
  @Get("sync/:jobId") async job(@Param("jobId") id: string) {
    const x = await this.anchor.job(id);
    if (!x) throw new NotFoundException();
    return x;
  }
  @Get("status") status() {
    return this.batches.status();
  }
  @Get("batches") list(
    @Query("status") status?: string,
    @Query("limit") limitValue?: string,
    @Query("tenantId") tenantId?: string,
  ) {
    return this.batches.list({
      status,
      tenantId,
      limit: limitValue ? Number(limitValue) : 100,
    });
  }
  @Get("batches/:id") async batch(@Param("id") id: string) {
    return this.anchor.getBatchDetails(id);
  }
  @Post("batches/:id/retry") @HttpCode(202) async retry(
    @Param("id") id: string,
  ) {
    const b = await this.batches.get(id);
    if (!b) throw new NotFoundException();
    if (b.status === "CONFIRMED")
      return { accepted: false, reason: "Batch is already confirmed" };
    this.anchor.retryBatch(id);
    return { accepted: true, batchId: id };
  }
  @Post("batches/:id/verify") @HttpCode(202) async verify(
    @Param("id") id: string,
  ) {
    const b = await this.batches.get(id);
    if (!b) throw new NotFoundException();
    void this.anchor.processBatch(b);
    return { accepted: true };
  }
  @Get("logs/:auditLogId/verify")
  async verifyLog(@Param("auditLogId") auditLogId: string) {
    return this.anchor.verifyLog(auditLogId);
  }
  @Get("logs")
  async listLogs(
    @Query("tenantId")
    tenantId?: string,

    @Query("actorType")
    actorType?: string,

    @Query("actionType")
    actionType?: string,

    @Query("status")
    status?: string,

    @Query("batchStatus")
    batchStatus?: string,

    @Query("processed")
    processedValue?: string,

    @Query("limit")
    limitValue?: string,

    @Query("offset")
    offsetValue?: string,
  ) {
    let processed: boolean | undefined;

    if (processedValue === "true") {
      processed = true;
    } else if (processedValue === "false") {
      processed = false;
    }

    return this.batches.listAuditLogs({
      tenantId,
      actorType,
      actionType,
      status,
      batchStatus,
      processed,

      limit: limitValue ? Number(limitValue) : 100,

      offset: offsetValue ? Number(offsetValue) : 0,
    });
  }
  @Get("logs/:auditLogId")
  getLogDetails(@Param("auditLogId") auditLogId: string) {
    return this.anchor.getLogDetails(auditLogId);
  }
  @Post("wallet/prepare")
  @HttpCode(HttpStatus.OK)
  prepareWalletBatches(
    @Body()
    body: {
      payerAccountId: string;
      tenantId?: string;
      maxEvents?: number;
      allBatches?: boolean;
    },
  ) {
    if (body.allBatches === true) {
      return this.anchor.prepareAllWalletBatches({
        payerAccountId: body.payerAccountId,
        tenantId: body.tenantId,
        maxEvents: body.maxEvents,
      });
    }
    return this.anchor.prepareWalletBatches({
      payerAccountId: body.payerAccountId,
      tenantId: body.tenantId,
      maxEvents: body.maxEvents,
    });
  }
  @Post("wallet/prepare-all")
  @HttpCode(HttpStatus.OK)
  prepareAllWalletBatches(
    @Body()
    body: {
      payerAccountId: string;
      tenantId?: string;
      maxEvents?: number;
      maxBatches?: number;
    },
  ) {
    const maxBatches = Math.min(Math.max(Number(body.maxBatches ?? 1000), 1), 1000);
    return this.anchor.prepareAllWalletBatches({
      payerAccountId: body.payerAccountId,
      tenantId: body.tenantId,
      maxEvents: body.maxEvents,
    }, maxBatches);
  }
  @Post("wallet/:batchId/submitted")
  @HttpCode(HttpStatus.ACCEPTED)
  submitWalletBatch(
    @Param("batchId") batchId: string,
    @Body()
    body: {
      transactionId?: string;
      topicId: string;
      sequenceNumber?: string;
      consensusTimestamp?: string;
    },
  ) {
    return this.anchor.recordWalletSubmission(batchId, body);
  }
}
