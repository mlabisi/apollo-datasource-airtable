const { AirtableDataSource } = require('../datasource');

class TestDataSource extends AirtableDataSource {
  initialize(config) {
    super.initialize(config);
  }
}

describe('AirtableDataSource', () => {
  it('should set up caching methods', () => {
    const testTable = {};
    const testSource = new TestDataSource(testTable);
    testSource.initialize();

    expect(testSource.findOneById).toBeDefined()
    expect(testSource.findByFields).toBeDefined()
    expect(testSource.deleteFromCacheById).toBeDefined()
    expect(testSource.deleteFromCacheByFields).toBeDefined()
    expect(testSource.table).toEqual(testTable)

  });
});
