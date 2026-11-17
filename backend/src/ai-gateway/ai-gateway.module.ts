import { Module } from '@nestjs/common';
import { AiGatewayService } from './ai-gateway.service.js';

/** Neon AI Gateway. No HTTP routes yet; feature modules import this and inject `AiGatewayService`. */
@Module({
  providers: [AiGatewayService],
  exports: [AiGatewayService],
})
export class AiGatewayModule {}
