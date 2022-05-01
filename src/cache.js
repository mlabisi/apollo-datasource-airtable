const DataLoader = require('dataloader');
const { EJSON } = require('bson');

const mapFieldsToFilters = (filterFields) => {
  const fieldsToFilters = {};
  const sortedFields = Object.keys(filterFields).sort();

  for (const fieldName of sortedFields) {
    // skip undefined field names
    if (typeof fieldName === 'undefined') {
      continue;
    }

    // wrap single values in an array
    fieldsToFilters[fieldName] = Array.isArray(filterFields[fieldName])
      ? filterFields[fieldName] // array of filters
      : [filterFields[fieldName]]; // single filter wrapped in array
  }

  return EJSON.stringify(fieldsToFilters);
};

const orderRecords = (fieldsToFilters, results) => {
  return fieldsToFilters.map((fieldAndFilters) => {
    // for each field name
    for (const fieldName in fieldAndFilters) {
      // if we want all records (aka field name is "ALL")
      if (fieldName === 'ALL') {
        return fieldAndFilters[fieldName]; // the value will be in the `fieldsToFilters` object
      }

      return results.filter((result) => {
        // otherwise, return filtered results
        const filterValues = fieldAndFilters[fieldName]; // get the filter values
        if (typeof filterValues === 'undefined') return false;
        const wrappedFilterValues = Array.isArray(filterValues)
          ? filterValues.map((val) => val.toLowerCase())
          : [filterValues.toString().toLowerCase()];

        const resultValue =
          fieldName === 'id' ? result.id : result.fields[fieldName]; // get the actual values
        if (typeof resultValue === 'undefined') return false;
        const wrappedResultValue = Array.isArray(resultValue)
          ? resultValue.map((val) => val.toLowerCase())
          : [resultValue.toString().toLowerCase()];

        let isMatch = false;
        for (const resultValue of wrappedResultValue) {
          if (wrappedFilterValues.includes(resultValue)) {
            // check if actual value is one of the filter values
            isMatch = true;
          }
        }

        return isMatch;
      });
    }
  });
};

const createCachingMethods = ({ table, cache }) => {
  const loader = new DataLoader(async (keys) => {
    // `keys` = array of objects
    const filters = [];
    const results = [];

    for (const curr of keys) {
      if (curr === 'ALL') {
        let all;
        await table
          .select({ view: 'Grid view' })
          .all()
          .then((allRecords) => {
            const records = [];

            allRecords.forEach((record) => {
              loader.prime(
                EJSON.stringify({ id: record.id.toString() }),
                EJSON.stringify(record._rawJson),
              );
              records.push(record._rawJson);
            });

            all = { ALL: records };
            filters.push(all);
          });
      } else {
        const currObj = EJSON.parse(curr);
        const filterFormulas = [];

        for (const fieldName in currObj) {
          if (typeof currObj[fieldName] === 'undefined') continue; // if there are no filters for the given field name, skip it
          // make sure its filter values are wrapped in an array
          const wrappedValues = Array.isArray(currObj[fieldName])
            ? currObj[fieldName]
            : [currObj[fieldName]];

          // for each filter value, create the airtable equivalent of the Array.includes function
          for (const value of wrappedValues) {
            filterFormulas.push(
              `(FIND("${value.toString().toLowerCase()}", LOWER(ARRAYJOIN(${
                fieldName === 'id' ? 'RECORD_ID()' : `{${fieldName}}`
              }))))>0`,
            );
          }

          // then, push the filter and its wrapped values to be ordered later
          filters.push({ [fieldName]: wrappedValues });
        }

        if (filterFormulas.length > 0) {
          const params = {
            filterByFormula: `OR(${filterFormulas.toString()})`, // collect and apply all filters
            view: 'Grid view',
          };

          await table.select(params).eachPage((records, fetchNextPage) => {
            records.forEach((record) => {
              results.push(record._rawJson);
            });

            fetchNextPage();
          });
        }
      }
    }

    return orderRecords(filters, results);
  });

  const cachePrefix = `airtable-${table.name}-`;

  const methods = {
    findOneById: async (id, { ttl }) => {
      // check cache for record with given id
      const cacheKey = cachePrefix + id.toString();
      const cachedRecord = await cache.get(cacheKey);

      // return the cached result
      if (cachedRecord) {
        return EJSON.parse(cachedRecord);
      }

      const wrappedRecord = await loader.load(
        EJSON.stringify({ id: id.toString() }),
      );

      if (ttl > 0) {
        cache.set(cacheKey, EJSON.stringify(wrappedRecord[0]), { ttl });
      }

      return wrappedRecord[0];
    },
    findManyByIds: (ids, { ttl } = {}) => {
      return Promise.all(ids.map((id) => methods.findOneById(id, { ttl })));
    },
    findByFields: async (filterFields, { ttl } = {}) => {
      // make all field names map to an array of values to filter with
      const loaderKey = mapFieldsToFilters(filterFields);

      // check cache for records found to match this filter
      const cacheKey = cachePrefix + loaderKey;
      const cachedResult = await cache.get(cacheKey);

      // return the cached result
      if (cachedResult) {
        return EJSON.parse(cachedResult);
      }

      const result = await loader.load(loaderKey); // load the records that match the given filters { <fieldName>: [<val1> [, ...<vals>]] }

      if (ttl > 0) {
        cache.set(cacheKey, EJSON.stringify(result), { ttl });
      }

      return result;
    },
    findAll: async ({ ttl } = {}) => {
      // check cache for records
      const cacheKey = cachePrefix + 'all';
      const cachedResult = await cache.get(cacheKey);

      // return the cached result
      if (cachedResult) {
        return EJSON.parse(cachedResult);
      }

      const wrappedResult = await loader.load('ALL');

      if (ttl > 0) {
        cache.set(cacheKey, EJSON.stringify(wrappedResult), { ttl });
      }

      return wrappedResult;
    },
    clearAllRecordsCache: async () => {
      loader.clear('ALL');
      await cache.delete(cachePrefix + 'all');
    },
    deleteFromCacheById: async (id) => {
      loader.clear(EJSON.stringify({ id: id.toString() }));
      const cacheKey = cachePrefix + id.toString();
      await cache.delete(cacheKey);
    },
    deleteFromCacheByFields: async (fields) => {
      const loaderKey = mapFieldsToFilters(fields);
      const cacheKey = cachePrefix + loader;
      loader.clear(loaderKey);
      await cache.delete(cacheKey);
    },
  };

  return methods;
};

module.exports = {
  createCachingMethods,
};
