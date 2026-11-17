var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { randomBytes } from 'node:crypto';
import { ConflictException, Injectable, UnauthorizedException, } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
const INVALID_CREDENTIALS = 'Invalid email or password';
let AuthService = class AuthService {
    prisma;
    passwords;
    tokens;
    dummyHash;
    constructor(prisma, passwords, tokens) {
        this.prisma = prisma;
        this.passwords = passwords;
        this.tokens = tokens;
    }
    async register(dto) {
        const passwordHash = await this.passwords.hash(dto.password);
        try {
            const { user, workspace } = await this.prisma.$transaction(async (tx) => {
                const user = await tx.user.create({
                    data: { email: dto.email, passwordHash, fullName: dto.fullName },
                });
                const workspace = await tx.workspace.create({
                    data: {
                        name: dto.workspaceName,
                        slug: slugify(dto.workspaceName),
                        ownerId: user.id,
                        members: { create: { userId: user.id, role: 'OWNER' } },
                    },
                });
                return { user, workspace };
            });
            const tokens = await this.tokens.issuePair({ sub: user.id, role: user.role });
            return {
                user: toPublicUser(user),
                workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
                ...tokens,
            };
        }
        catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002') {
                throw new ConflictException('Email is already registered');
            }
            throw error;
        }
    }
    async login(dto) {
        const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
        if (!user) {
            await this.passwords.verify(await this.getDummyHash(), dto.password);
            throw new UnauthorizedException(INVALID_CREDENTIALS);
        }
        if (!(await this.passwords.verify(user.passwordHash, dto.password))) {
            throw new UnauthorizedException(INVALID_CREDENTIALS);
        }
        const tokens = await this.tokens.issuePair({ sub: user.id, role: user.role });
        return { user: toPublicUser(user), ...tokens };
    }
    async refresh(refreshToken) {
        const payload = await this.tokens.verifyRefresh(refreshToken);
        const user = await this.prisma.user.findUnique({
            where: { id: payload.sub },
            select: { id: true, role: true },
        });
        if (!user)
            throw new UnauthorizedException('Invalid or expired token');
        return this.tokens.issuePair({ sub: user.id, role: user.role });
    }
    async me(auth) {
        const user = await this.prisma.user.findUnique({
            where: { id: auth.sub },
            include: {
                memberships: {
                    where: auth.workspaceId ? { workspaceId: auth.workspaceId } : undefined,
                    include: { workspace: { select: { id: true, name: true, slug: true, status: true } } },
                    orderBy: { createdAt: 'asc' },
                },
            },
        });
        if (!user)
            throw new UnauthorizedException('Invalid or expired token');
        return {
            user: toPublicUser(user),
            workspaces: user.memberships.map((m) => ({ ...m.workspace, role: m.role })),
            impersonatedBy: auth.impersonatedBy ?? null,
        };
    }
    getDummyHash() {
        this.dummyHash ??= this.passwords.hash(randomBytes(16).toString('hex'));
        return this.dummyHash;
    }
};
AuthService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        PasswordService,
        TokenService])
], AuthService);
export { AuthService };
function toPublicUser(user) {
    const { id, email, fullName, role, createdAt } = user;
    return { id, email, fullName, role, createdAt };
}
export function slugify(name) {
    const base = name
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'workspace';
    return `${base}-${randomBytes(3).toString('hex')}`;
}
//# sourceMappingURL=auth.service.js.map