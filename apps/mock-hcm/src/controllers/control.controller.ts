import { Controller } from '@nestjs/common';

/**
 * Test-only control plane for scenario injection and state inspection
 * (mock-hcm.md §3). Behavior arrives with the tests that need it, starting
 * Cycle 02; the cycle-01 skeleton only needs the controller to register.
 */
@Controller('mock/control')
export class ControlController {}
