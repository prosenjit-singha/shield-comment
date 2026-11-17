import { type User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AccessTokenPayload, TokenPair } from './auth.types.js';
import type { LoginDto, RegisterDto } from './dto/auth.dto.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
export type PublicUser = Pick<User, 'id' | 'email' | 'fullName' | 'role' | 'createdAt'>;
export declare class AuthService {
    private readonly prisma;
    private readonly passwords;
    private readonly tokens;
    private dummyHash?;
    constructor(prisma: PrismaService, passwords: PasswordService, tokens: TokenService);
    register(dto: RegisterDto): Promise<{
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        user: PublicUser;
        workspace: {
            id: string;
            name: string;
            slug: string;
        };
    }>;
    login(dto: LoginDto): Promise<{
        user: PublicUser;
    } & TokenPair>;
    refresh(refreshToken: string): Promise<TokenPair>;
    me(auth: AccessTokenPayload): Promise<{
        user: PublicUser;
        workspaces: {
            role: import("../generated/prisma/enums.js").WorkspaceMemberRole;
            id: string;
            name: string;
            slug: string;
            status: import("../generated/prisma/enums.js").WorkspaceStatus;
        }[];
        impersonatedBy: string | null;
    }>;
    private getDummyHash;
}
export declare function slugify(name: string): string;
