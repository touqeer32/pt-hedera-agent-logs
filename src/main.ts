import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const requestLog = new Logger("HttpRequest");

  app.use((request: any, response: any, next: () => void) => {
    const startedAt = Date.now();
    const requestId = request.headers["x-request-id"] || randomUUID();
    const tenantId = request.headers["x-tenant-id"] || request.headers.tenantid || null;
    const userId = request.headers["x-user-id"] || request.headers.userid || null;
    const agentId = request.headers["x-agent-id"] || null;
    const runId = request.headers["x-run-id"] || request.headers["x-agent-run-id"] || null;
    const triggerSource = request.headers["x-trigger-source"] || null;
    const actorType = request.headers["x-actor-type"] || (agentId || runId ? "AGENT" : "UNKNOWN");
    const forwardedFor = request.headers["x-forwarded-for"] || null;
    const userAgent = request.headers["user-agent"] || null;

    request.requestId = requestId;
    requestLog.log({
      event: "HTTP_REQUEST_STARTED",
      requestId,
      method: request.method,
      path: request.originalUrl || request.url,
      tenantId,
      userId,
      agentId,
      runId,
      actorType,
      triggerSource,
      forwardedFor,
      userAgent,
    });

    response.on("finish", () => {
      requestLog.log({
        event: "HTTP_REQUEST_COMPLETED",
        requestId,
        method: request.method,
        path: request.originalUrl || request.url,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
        tenantId,
        userId,
        agentId,
        runId,
        actorType,
        triggerSource,
      });
    });

    next();
  });
  app.setGlobalPrefix("api/v1");
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}
void bootstrap();
