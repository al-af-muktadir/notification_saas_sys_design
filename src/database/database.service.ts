import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';

import { Pool, PoolClient, QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  private readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
  });

  async onModuleInit() {
    await this.pool.query('SELECT 1');
    this.logger.log('PostgreSQL connected successfully');
  }

  async onModuleDestroy() {
    await this.pool.end();
    this.logger.log('PostgreSQL connection pool closed');
  }

  // Normal queries
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ) {
    return this.pool.query<T>(sql, params);
  }

  // Transaction support
  async transaction<T>(
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const result = await callback(client);

      await client.query('COMMIT');

      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        this.logger.error('Transaction rollback failed', rollbackError);
      }

      throw error;
    } finally {
      client.release();
    }
  }
}
