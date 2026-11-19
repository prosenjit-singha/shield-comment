import { Transform } from 'class-transformer';
import { IsString, Matches, ValidateIf } from 'class-validator';
import { SUPPORT_WHATSAPP_PATTERN } from '../../db/schema/index.js';

/**
 * Platform settings shown to clients (PR-T4, PR-D18): `GET` / `PATCH
 * /api/admin/settings/platform` → `PlatformSettings`. Stored in `platform_settings` (one row,
 * `id = 1`, created by the first save; no row = all `null`).
 */
export interface PlatformSettings {
  /** WhatsApp number behind "Contact us" (`8801XXXXXXXXX`); `null` = the button is hidden. */
  supportWhatsappNumber: string | null;
  /** Last save; `null` = never saved. */
  updatedAt: string | null;
}

export class UpdatePlatformSettingsDto {
  /**
   * Required key. BD mobile with the country code, digits only (`^8801[3-9][0-9]{8}$`, e.g.
   * `8801712345678`), trimmed; `null` or a blank string clears it.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : value,
  )
  @ValidateIf(
    (o: UpdatePlatformSettingsDto) => o.supportWhatsappNumber !== null,
  )
  @IsString()
  @Matches(new RegExp(SUPPORT_WHATSAPP_PATTERN), {
    message:
      'supportWhatsappNumber must be a Bangladesh mobile number like 8801712345678',
  })
  supportWhatsappNumber!: string | null;
}
