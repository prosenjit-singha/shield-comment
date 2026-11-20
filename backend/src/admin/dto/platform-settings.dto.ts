import { Transform } from 'class-transformer';
import {
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  PLAYGROUND_DAILY_LIMIT_MAX,
  SUPPORT_WHATSAPP_PATTERN,
} from '../../db/schema/index.js';

/**
 * Platform settings (PR-T4, PR-D18; playground limit M6-T7b, D9): `GET` / `PATCH
 * /api/admin/settings/platform` → `PlatformSettings`. Stored in `platform_settings` (one row,
 * `id = 1`, created by the first save; no row = the defaults below).
 */
export interface PlatformSettings {
  /** WhatsApp number behind "Contact us" (`8801XXXXXXXXX`); `null` = the button is hidden. */
  supportWhatsappNumber: string | null;
  /** Playground tests per workspace per Dhaka day, 0–1,000 (no row → 10; 0 = playground off). */
  playgroundDailyLimit: number;
  /** Last save; `null` = never saved. */
  updatedAt: string | null;
}

/** Partial: send at least one key (empty body → 400 in the service); absent keys keep their value. */
export class UpdatePlatformSettingsDto {
  /**
   * BD mobile with the country code, digits only (`^8801[3-9][0-9]{8}$`, e.g. `8801712345678`),
   * trimmed; `null` or a blank string clears it.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : value,
  )
  @ValidateIf(
    (o: UpdatePlatformSettingsDto) =>
      o.supportWhatsappNumber !== null && o.supportWhatsappNumber !== undefined,
  )
  @IsString()
  @Matches(new RegExp(SUPPORT_WHATSAPP_PATTERN), {
    message:
      'supportWhatsappNumber must be a Bangladesh mobile number like 8801712345678',
  })
  supportWhatsappNumber?: string | null;

  /** Whole number 0–1,000 (JSON number only: no strings, no `null`). */
  @ValidateIf(
    (o: UpdatePlatformSettingsDto) => o.playgroundDailyLimit !== undefined,
  )
  @IsInt()
  @Min(0)
  @Max(PLAYGROUND_DAILY_LIMIT_MAX)
  playgroundDailyLimit?: number;
}
