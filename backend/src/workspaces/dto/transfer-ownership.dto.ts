import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { UUID } from '../../support-tickets/dto/tickets.dto.js';

/** `POST …/team/transfer-ownership` (M7-T6b): which fields are required depends on the method. */
export class TransferOwnershipDto {
  @Matches(UUID, { message: 'memberId must be a UUID' })
  memberId!: string;

  /** Password method: the current password, twice (Better Auth max length 128). */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  passwordConfirm?: string;

  /** Code method: the 6-digit emailed code. */
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code?: string;
}
