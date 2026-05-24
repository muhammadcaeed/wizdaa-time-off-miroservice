import { Injectable } from '@nestjs/common';

/** Endpoints whose behavior can be overridden by a scenario. */
export type EndpointName = 'adjust' | 'get_balance' | 'batch';

/**
 * Scenarios supported by the mock (mock-hcm.md §4). Cycle 02 added the
 * ambiguous/unverifiable success variants; cycle 03 adds the chaos failure
 * injectors (`slow`, `flaky`, `down`, `network-failure`).
 */
export type ScenarioName =
  | 'normal'
  | 'ambiguous-success'
  | 'unverifiable-success'
  | 'slow'
  | 'flaky'
  | 'down'
  | 'network-failure';

/** Optional filter narrowing a scenario to a subset of operations. */
export interface ScenarioScope {
  employee_id?: string;
  location_id?: string;
}

/** A scenario assignment recorded via the control plane. */
export interface ScenarioAssignment {
  endpoints: Partial<Record<EndpointName, ScenarioName>>;
  scope?: ScenarioScope;
}

const DEFAULT_SCENARIO: ScenarioName = 'normal';

/**
 * Resolves which scenario governs a given operation, honoring scope so that
 * concurrent tests don't poison each other (mock-hcm.md §3.1). More-specific
 * scoped assignments win over global ones; endpoints resolve independently.
 */
@Injectable()
export class ScenarioService {
  private assignments: ScenarioAssignment[] = [];

  /** Per-endpoint call counter backing the deterministic `flaky` scenario. */
  private flakyCounters = new Map<EndpointName, number>();

  /**
   * Records a scenario assignment. Later assignments take precedence over
   * earlier ones at the same specificity.
   * @param assignment endpoint scenarios plus optional scope
   * @returns nothing
   */
  set(assignment: ScenarioAssignment): void {
    this.assignments.push(assignment);
  }

  /**
   * Resolves the governing scenario for an operation.
   * @param endpoint the endpoint being exercised
   * @param employeeId employee identifier of the operation
   * @param locationId location identifier of the operation
   * @returns the resolved scenario, defaulting to `normal`
   */
  resolve(endpoint: EndpointName, employeeId: string, locationId: string): ScenarioName {
    let best: { scenario: ScenarioName; specificity: number } | undefined;

    for (const assignment of this.assignments) {
      const scenario = assignment.endpoints[endpoint];
      if (scenario === undefined) {
        continue;
      }
      const specificity = this.scopeSpecificity(assignment.scope, employeeId, locationId);
      if (specificity < 0) {
        continue;
      }
      if (best === undefined || specificity >= best.specificity) {
        best = { scenario, specificity };
      }
    }

    return best?.scenario ?? DEFAULT_SCENARIO;
  }

  /**
   * Clears all scenario assignments back to the default.
   * @returns nothing
   */
  reset(): void {
    this.assignments = [];
    this.flakyCounters.clear();
  }

  /**
   * Decides, deterministically, whether the next `flaky` call should fail.
   *
   * Counter-based rather than `Math.random` so the chaos suite is
   * reproducible (mock-hcm.md §4). We fail every Nth call where
   * `N = round(1 / fail_rate)`: `fail_rate=0.5` fails every 2nd call,
   * `fail_rate=0.34` fails every 3rd. The counter is per-endpoint and is
   * reset by {@link reset}.
   *
   * @param endpoint the endpoint being exercised
   * @param failRate desired failure fraction in (0, 1]
   * @returns true when this call should be failed with a 5xx
   */
  shouldFlakyFail(endpoint: EndpointName, failRate: number): boolean {
    const next = (this.flakyCounters.get(endpoint) ?? 0) + 1;
    this.flakyCounters.set(endpoint, next);
    if (failRate <= 0) {
      return false;
    }
    const period = Math.max(1, Math.round(1 / failRate));
    return next % period === 0;
  }

  /**
   * Returns the recorded scenario assignments for state inspection.
   * @returns a copy of the assignment list
   */
  snapshot(): ScenarioAssignment[] {
    return this.assignments.map((assignment) => ({ ...assignment }));
  }

  /**
   * Scores how specifically a scope matches an operation.
   * @returns -1 if the scope excludes the operation, otherwise the number of
   *   matched scope fields (0 for an unscoped/global assignment)
   */
  private scopeSpecificity(
    scope: ScenarioScope | undefined,
    employeeId: string,
    locationId: string,
  ): number {
    if (scope === undefined) {
      return 0;
    }
    let matched = 0;
    if (scope.employee_id !== undefined) {
      if (scope.employee_id !== employeeId) {
        return -1;
      }
      matched += 1;
    }
    if (scope.location_id !== undefined) {
      if (scope.location_id !== locationId) {
        return -1;
      }
      matched += 1;
    }
    return matched;
  }
}
