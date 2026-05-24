import fc from 'fast-check';
import { ApplicationDriver, type Op } from '../../../../../test/support/driver';

const NUM_RUNS = process.env.CI ? 1000 : 200;

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant<'submit'>('submit'),
    emp: fc.integer({ min: 0, max: 4 }),
    days: fc.integer({ min: 1, max: 8 }),
  }),
  fc.record({ kind: fc.constant<'approve'>('approve'), pick: fc.nat({ max: 1000 }) }),
  fc.record({ kind: fc.constant<'reject'>('reject'), pick: fc.nat({ max: 1000 }) }),
);

/**
 * @req INV-01
 * @req INV-02
 * @req INV-03
 */
describe('balance invariants under random operation sequences (property-based)', () => {
  it('INV-01/02/03 hold after any sequence of submit/approve/reject', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 50 }), async (ops) => {
        const driver = await ApplicationDriver.create(5);
        try {
          for (const op of ops) {
            await driver.apply(op);
          }
          await driver.assertInvariants();
        } finally {
          await driver.destroy();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
