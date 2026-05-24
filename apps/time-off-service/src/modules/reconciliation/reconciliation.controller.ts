import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ReconciliationNotFoundError } from '../../common/errors/reconciliation-not-found.error';
import { Roles } from '../auth/roles.decorator';
import { ListReconciliationsQueryDto } from './dto/list-reconciliations-query.dto';
import {
  toReconciliationResponse,
  type ReconciliationListResponse,
  type ReconciliationResponse,
} from './dto/reconciliation-response.dto';
import { ReconciliationRepository } from './reconciliation.repository';
import { ReconciliationService } from './reconciliation.service';

/**
 * Admin-only reconciliation surface (api-contract.md §2). The global `api/v1`
 * prefix makes these `/api/v1/reconciliations`. Every route requires `ADMIN`:
 * reconciliation is an operational concern, not a tenant-facing one.
 */
@Controller('reconciliations')
@Roles('ADMIN')
export class ReconciliationController {
  constructor(
    private readonly reconciliationService: ReconciliationService,
    private readonly reconciliationRepository: ReconciliationRepository,
  ) {}

  /**
   * Triggers an on-demand batch reconciliation run (REQ-REC-01). Responds 202;
   * the body is the finalized run resource. A concurrent run surfaces as 409
   * `/errors/reconciliation-in-progress` via the {@link ReconciliationInProgressError}
   * thrown inside the service and mapped by the global domain filter (REQ-REC-06).
   * @returns the finalized run (COMPLETED, COMPLETED_WITH_CONFLICTS, or FAILED)
   * @throws ReconciliationInProgressError (409) when another run is RUNNING
   */
  @Post()
  @HttpCode(202)
  async trigger(): Promise<ReconciliationResponse> {
    const run = await this.reconciliationService.runOnDemand();
    return toReconciliationResponse(run);
  }

  /**
   * Lists reconciliation runs newest-first with cursor pagination (REQ-REC-01
   * surface, api-contract.md §5).
   * @param query optional `cursor` and `limit`
   * @returns a cursor page of runs
   * @throws ReconciliationCursorError (400) when the cursor is malformed
   */
  @Get()
  async list(@Query() query: ListReconciliationsQueryDto): Promise<ReconciliationListResponse> {
    const page = await this.reconciliationRepository.list(query.limit, query.cursor);
    return {
      data: page.data.map(toReconciliationResponse),
      pagination: page.pagination,
    };
  }

  /**
   * Reads a single reconciliation run (REQ-REC-04, api-contract.md §2).
   * @param id the run id
   * @returns the run resource
   * @throws ReconciliationNotFoundError (404) when no run has that id
   */
  @Get(':id')
  async findOne(@Param('id') id: string): Promise<ReconciliationResponse> {
    const run = await this.reconciliationRepository.findById(id);
    if (!run) {
      throw new ReconciliationNotFoundError();
    }
    return toReconciliationResponse(run);
  }
}
