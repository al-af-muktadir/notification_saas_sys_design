import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
  });

  async onModuleInit() {
    await this.pool.query('SELECT 1');
    //g('PostgreSQL connected successfully');
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: any[] = [],
  ) {
    //g('\n========== DATABASE: QUERY START ==========');
    //g('[Database] SQL:', sql);
    //g('[Database] Parameters:', params);

    return this.pool
      .query<T>(sql, params)
      .then((result) => {
        //g('[Database] Query completed successfully');
        //g('[Database] Rows returned:', result.rows);
        //g('[Database] Row count:', result.rowCount);
        //g('========== DATABASE: QUERY END ==========\n');

        return result;
      })
      .catch((error) => {
        console.error('[Database] Query FAILED:', error.message);
        console.error('[Database] PostgreSQL error code:', error.code);

        throw error;
      });
  }
}
