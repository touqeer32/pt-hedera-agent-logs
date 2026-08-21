import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool } from "pg";

export const PG_POOL = Symbol("PG_POOL");
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: async (c: ConfigService) => {
        const pool = new Pool({
          connectionString: c.getOrThrow("DATABASE_URL"),
        });

        // Keep deployed databases compatible with wallet batch details.
        // The full SQL migration remains in src/database/001_audit_anchor.sql.
        await pool.query(`
          ALTER TABLE IF EXISTS audit_batches
          ADD COLUMN IF NOT EXISTS wallet_transaction_bytes TEXT
        `);

        return pool;
      },
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule {}
