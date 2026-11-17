import type { AccessTokenPayload } from './auth.types.js';
import { AuthService } from './auth.service.js';
import { LoginDto, RefreshDto, RegisterDto } from './dto/auth.dto.js';
export declare class AuthController {
    private readonly auth;
    constructor(auth: AuthService);
    register(dto: RegisterDto): Promise<{
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        user: import("./auth.service.js").PublicUser;
        workspace: {
            id: string;
            name: string;
            slug: string;
        };
    }>;
    login(dto: LoginDto): Promise<{
        user: import("./auth.service.js").PublicUser;
    } & import("./auth.types.js").TokenPair>;
    refresh(dto: RefreshDto): Promise<import("./auth.types.js").TokenPair>;
    me(user: AccessTokenPayload): Promise<{
        user: import("./auth.service.js").PublicUser;
        workspaces: {
            role: import("../generated/prisma/enums.js").WorkspaceMemberRole;
            id: string;
            name: string;
            slug: string;
            status: import("../generated/prisma/enums.js").WorkspaceStatus;
        }[];
        impersonatedBy: string | null;
    }>;
}
