import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuditAnchorModule } from './audit-anchor/audit-anchor.module';
import { DatabaseModule } from './database/database.module';

@Module({imports:[ConfigModule.forRoot({isGlobal:true}),ScheduleModule.forRoot(),DatabaseModule,AuditAnchorModule]})
export class AppModule {}
