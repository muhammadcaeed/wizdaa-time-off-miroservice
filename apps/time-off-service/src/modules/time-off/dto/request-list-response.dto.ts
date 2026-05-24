import type { RequestResponse } from './request-response.dto';

/** A paginated page of requests (api-contract.md §5). */
export class RequestListResponse {
  data!: RequestResponse[];
  pagination!: { next_cursor: string | null; has_more: boolean };
}
