import { Body, Controller, Get, Inject, Injectable, Module, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import bcrypt from 'bcryptjs';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { and, eq, inArray } from 'drizzle-orm';
import { RoleName } from '@rms/shared';
import { Actor, CurrentUser, permissionsFor, Public } from '../common/auth';
import { DB } from '../common/db.module';
import { Db } from '../db/client';
import { users } from '../db/schema';

export class LoginDto {
  @ApiProperty({ example: 'cashier' }) @IsString() username: string;
  @ApiProperty({ example: 'cashier123' }) @IsString() @MinLength(3) password: string;
  @ApiProperty({ required: false, description: 'Stable id of the POS device, used for offline sync' })
  @IsOptional()
  @IsString()
  deviceId?: string;
}

export class OverrideDto {
  @ApiProperty({ example: '1111', description: 'Manager / owner PIN' }) @IsString() pin: string;
  @ApiProperty({ required: false, description: 'Optional: restrict which manager (username)' }) @IsOptional() @IsString() username?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.db.query.users.findFirst({ where: and(eq(users.username, dto.username), eq(users.active, true)) });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) throw new UnauthorizedException('Invalid credentials');
    const permissions = permissionsFor(user.role as RoleName, user.permissionOverrides);
    const payload = { sub: user.id, outletId: user.outletId, name: user.name, username: user.username, role: user.role, permissions };
    return {
      token: await this.jwt.signAsync(payload),
      user: { id: user.id, name: user.name, username: user.username, role: user.role, outletId: user.outletId, permissions },
    };
  }

  /** Verify a manager PIN and mint a 5-minute override token for a sensitive action. */
  async override(actor: Actor, dto: OverrideDto) {
    const candidates = await this.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.outletId, actor.outletId),
          eq(users.active, true),
          inArray(users.role, ['OWNER', 'MANAGER']),
          ...(dto.username ? [eq(users.username, dto.username)] : []),
        ),
      );
    for (const m of candidates) {
      if (m.pinHash && (await bcrypt.compare(dto.pin, m.pinHash))) {
        const token = await this.jwt.signAsync(
          { kind: 'override', sub: m.id, name: m.name, outletId: m.outletId },
          { expiresIn: '5m' },
        );
        return { overrideToken: token, by: { id: m.id, name: m.name }, expiresInSeconds: 300 };
      }
    }
    throw new UnauthorizedException('Invalid manager PIN');
  }
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Login with username/password → JWT' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Get('me')
  @ApiBearerAuth()
  me(@CurrentUser() user: Actor) {
    return user;
  }

  @Post('override')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify manager PIN → short-lived override token (send as X-Override-Token)' })
  override(@CurrentUser() user: Actor, @Body() dto: OverrideDto) {
    return this.auth.override(user, dto);
  }
}

@Module({ controllers: [AuthController], providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
