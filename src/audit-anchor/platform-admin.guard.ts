import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(ctx: ExecutionContext) {
    const expected = this.config.get<string>("PLATFORM_ADMIN_API_KEY");
    const actual = ctx.switchToHttp().getRequest().headers[
      "x-platform-admin-key"
    ];
    if (!expected || actual !== expected) throw new UnauthorizedException();
    return true;
  }
}
