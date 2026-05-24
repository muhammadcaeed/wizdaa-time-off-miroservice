import { Module } from '@nestjs/common';
import { BalanceRepository } from './balance.repository';
import { BalancesController } from './balances.controller';
import { BalancesService } from './balances.service';

/** Balance read surface plus the shared {@link BalanceRepository} (used by the saga). */
@Module({
  controllers: [BalancesController],
  providers: [BalancesService, BalanceRepository],
  exports: [BalanceRepository],
})
export class BalancesModule {}
