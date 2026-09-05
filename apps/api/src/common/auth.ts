import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Permission, ROLE_PERMISSIONS, RoleName } from '@rms/shared';

export interface Actor {
  id: string;
  outletId: string;
  name: string;
  username: string;
  role: RoleName;
  permissions: Permission[];
  /** set when the request carried a valid manager-override token */
  override?: { byUserId: string; byName: string };
}

export const PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const PERMS_KEY = 'perms';
export const RequirePerms = (...perms: Permission[]) => SetMetadata(PERMS_KEY, perms);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => ctx.switchToHttp().getRequest().user);

export function permissionsFor(role: RoleName, overrides?: { grant?: string[]; revoke?: string[] }): Permission[] {
  const base = new Set<Permission>(ROLE_PERMISSIONS[role] ?? []);
  overrides?.grant?.forEach((p) => base.add(p as Permission));
  overrides?.revoke?.forEach((p) => base.delete(p as Permission));
  return [...base];
}

export function hasPerm(actor: Actor, perm: Permission): boolean {
  return actor.permissions.includes(perm);
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing bearer token');
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const actor: Actor = {
      id: payload.sub,
      outletId: payload.outletId,
      name: payload.name,
      username: payload.username,
      role: payload.role,
      permissions: payload.permissions ?? permissionsFor(payload.role),
    };
    // Optional manager override token (X-Override-Token) minted by POST /auth/override
    const ov: string | undefined = req.headers['x-override-token'];
    if (ov) {
      try {
        const o = await this.jwt.verifyAsync(ov);
        if (o.kind === 'override' && o.outletId === actor.outletId) actor.override = { byUserId: o.sub, byName: o.name };
      } catch {
        /* ignore bad override tokens – the action will be rejected later if it needed one */
      }
    }
    req.user = actor;
    const perms = this.reflector.getAllAndOverride<Permission[]>(PERMS_KEY, [ctx.getHandler(), ctx.getClass()]) ?? [];
    for (const p of perms) {
      if (!hasPerm(actor, p) && !actor.override) throw new ForbiddenException(`Missing permission: ${p}`);
    }
    return true;
  }
}
