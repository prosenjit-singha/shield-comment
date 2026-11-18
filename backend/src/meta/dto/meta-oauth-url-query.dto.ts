import { IsIn, IsOptional } from 'class-validator';
import {
  META_OAUTH_RETURN_PATHS,
  type MetaOAuthReturnPath,
} from '../meta-oauth-state.js';

/** `GET …/meta/oauth/url?returnTo=/onboarding|/pages` (default `/onboarding`, D6 allowlist). */
export class MetaOAuthUrlQueryDto {
  @IsOptional()
  @IsIn(META_OAUTH_RETURN_PATHS)
  returnTo?: MetaOAuthReturnPath;
}
