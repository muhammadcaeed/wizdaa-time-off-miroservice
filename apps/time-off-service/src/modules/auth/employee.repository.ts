import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { Employee } from '../../database/entities';

/** Read access to {@link Employee} for authorization and ownership checks. */
@Injectable()
export class EmployeeRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findById(
    id: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Employee | null> {
    return manager.getRepository(Employee).findOne({ where: { id } });
  }
}
