const { DataSource } = require('apollo-datasource');
const { InMemoryLRUCache } = require('apollo-server-caching');

import { createCachingMethods } from './cache';

class AirtableDataSource extends DataSource {
  constructor(table) {
    super();
    this.table = table;
  }

  // https://github.com/apollographql/apollo-server/blob/master/packages/apollo-datasource/src/index.ts
  initialize({ context, cache } = {}) {
    this.context = context;

    const methods = createCachingMethods({
      table: this.table,
      base: this.context.Airtable,
      cache: cache || new InMemoryLRUCache(),
    });

    Object.assign(this, methods);
  }
}

export { AirtableDataSource };
