import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import { IdempotencyService } from './idempotency.service';

/**
 * @req REQ-IDEM-01
 * @req REQ-IDEM-02
 * @req REQ-IDEM-05
 */
describe('IdempotencyService', () => {
  let service: IdempotencyService;
  let mockRepo: Partial<Repository<IdempotencyRecord>>;
  let mockDataSource: Partial<DataSource>;
  let mockManager: Partial<EntityManager>;

  beforeEach(async () => {
    mockRepo = {
      findOneBy: vi.fn(),
      delete: vi.fn(),
      insert: vi.fn(),
    };

    mockManager = {
      getRepository: vi.fn().mockReturnValue({
        insert: vi.fn(),
      }),
    };

    mockDataSource = {
      getRepository: vi.fn().mockReturnValue(mockRepo),
    };

    const module = await Test.createTestingModule({
      providers: [
        IdempotencyService,
        {
          provide: getDataSourceToken(),
          useValue: mockDataSource,
        },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn().mockReturnValue(24),
          },
        },
      ],
    }).compile();

    service = module.get(IdempotencyService);
  });

  describe('check()', () => {
    it('returns null for unknown key', async () => {
      vi.mocked(mockRepo.findOneBy!).mockResolvedValue(null);

      const result = await service.check('unknown-key');

      expect(result).toBeNull();
    });

    it('returns record for known non-expired key', async () => {
      const future = new Date(Date.now() + 1000 * 60 * 60);
      const storedRecord: IdempotencyRecord = {
        key: 'known-key',
        requestHash: 'hash123',
        responseBody: { id: 'req-1', status: 'SUBMITTED' },
        responseStatus: 201,
        createdAt: new Date(),
        expiresAt: future,
      };
      vi.mocked(mockRepo.findOneBy!).mockResolvedValue(storedRecord);

      const result = await service.check('known-key');

      expect(result).toEqual({
        requestHash: 'hash123',
        responseStatus: 201,
        responseBody: { id: 'req-1', status: 'SUBMITTED' },
      });
    });

    it('returns null for expired key', async () => {
      const past = new Date(Date.now() - 1000);
      const expiredRecord: IdempotencyRecord = {
        key: 'expired-key',
        requestHash: 'hash456',
        responseBody: { id: 'req-2', status: 'SUBMITTED' },
        responseStatus: 201,
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 25),
        expiresAt: past,
      };
      vi.mocked(mockRepo.findOneBy!).mockResolvedValue(expiredRecord);

      const result = await service.check('expired-key');

      expect(result).toBeNull();
    });
  });

  describe('record()', () => {
    it('inserts row via manager when key is defined', async () => {
      const insertFn = vi.fn().mockResolvedValue(undefined);
      vi.mocked(mockManager.getRepository!).mockReturnValue({
        insert: insertFn,
      } as unknown as Repository<IdempotencyRecord>);

      await service.record(
        'new-key',
        'hash789',
        201,
        { id: 'req-3', status: 'SUBMITTED' },
        mockManager as EntityManager,
      );

      expect(mockManager.getRepository).toHaveBeenCalledWith(IdempotencyRecord);
      expect(insertFn).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'new-key',
          requestHash: 'hash789',
          responseStatus: 201,
          responseBody: { id: 'req-3', status: 'SUBMITTED' },
        }),
      );
    });

    it('is a no-op when key is undefined', async () => {
      const insertFn = vi.fn();

      await service.record(undefined, 'hash', 200, {}, mockManager as EntityManager);

      expect(insertFn).not.toHaveBeenCalled();
      expect(mockManager.getRepository).not.toHaveBeenCalled();
    });
  });

  describe('cleanup()', () => {
    it('deletes expired rows', async () => {
      vi.mocked(mockRepo.delete!).mockResolvedValue({ affected: 3, raw: [] });

      await service.cleanup();

      // LessThan wraps a Date — verify the delete was called with an object
      // that has an `expiresAt` key; the exact FindOperator value is opaque.
      expect(mockRepo.delete).toHaveBeenCalledTimes(1);
      const [arg] = vi.mocked(mockRepo.delete!).mock.calls[0] as [Record<string, unknown>];
      expect(arg).toHaveProperty('expiresAt');
    });
  });
});
