const { DataSource } = require('apollo-datasource');
const { InMemoryLRUCache } = require('apollo-server-caching');

const { createCachingMethods } = require('./cache');

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
      cache: cache || new InMemoryLRUCache(),
    });

    Object.assign(this, methods);
  }
}

module.exports = {
  AirtableDataSource
}
