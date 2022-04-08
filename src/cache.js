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

  return {
    loaderKey: EJSON.stringify(fieldsToFilters),
    fieldsToFilters,
  };
};

const orderRecords = (fieldsToFilters, results) => {
  return fieldsToFilters.map((fieldAndFilters) => {
    // for each field name
    for (const fieldName in fieldAndFilters) {
      // if we want all records (aka field name is "ALL")
      if (fieldName === 'ALL') {
        return fieldAndFilters[fieldName]; // the value will be in the `fieldsToFilters` object
      }

      // otherwise, return filtered results
      return results.filter((result) => {
        const filterValues = fieldAndFilters[fieldName]; // get the filter values
        if (typeof filterValues === 'undefined') return false;
        const wrappedFilterValues = Array.isArray(filterValues)
          ? filterValues.map((val) => val.toLowerCase())
          : [filterValues.toString().toLowerCase()];

        const resultValue = result.fields[fieldName]; // get the actual values
        if (typeof resultValue === 'undefined') return false;
        const wrappedResultValue = Array.isArray(resultValue)
          ? resultValue.map((val) => val.toLowerCase())
          : [resultValue.toString().toLowerCase()];

        let isMatch = false;
        do {
          for (const filterValue of wrappedFilterValues) {
            if (wrappedResultValue.includes(filterValue)) {
              // check if actual value is one of the filter values
              isMatch = true;
            }
          }
        } while (!isMatch);

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

    // check filters and collect all matching records
    for (const curr of keys) {
      // if the current object is the string "ALL", then retrieve all records
      if (curr === 'ALL') {
        await table
          .select({ view: 'Grid view' })
          .all()
          .then((allRecords) => {
            filters.push({ ALL: allRecords.map((record) => record._rawJson) });
          });
      } else {
        const currObj = EJSON.parse(curr);

        // consolidate potential duplicates
        const existing = filters.find(
          (obj) =>
            [...Object.keys(obj)].sort().join() ===
            [...Object.keys(currObj)].sort().join(),
          // the existing fields to be filtered === the current fields to be filtered
        );
        const fields = existing || {}; // if we already registered this combo of filters, we'll load up its filter values and append any new ones

        for (const fieldName in currObj) {
          if (typeof currObj[fieldName] === 'undefined') continue; // if there are no filters for the given field name, skip it
          const wrappedValues = Array.isArray(currObj[fieldName])
            ? currObj[fieldName]
            : [currObj[fieldName]];

          if (!fields[fieldName])
            fields[fieldName] = {
              values: wrappedValues,
            };
          // if it's the first time we're seeing this field name, make sure its filter values are wrapped in an array
          else
            fields[fieldName].values = [
              ...fields[fieldName].values,
              ...wrappedValues,
            ]; // otherwise, add the new values to the existing list of filter values for this field

          const cases = fields[fieldName].values.map(
            (value) => `"${value.toString()}", 1`,
          ); // for each filter value, add the case to the airtable switch statement
          fields[fieldName].formula = `(SWITCH(${fieldName === "id" ? 'RECORD_ID()' : `{${fieldName}}`},${cases}, 0))=1`; // once all possible values for this field name have been added to the switch, generate the condition
        }

        const filterFormulas = [];

        for (const fieldName in fields) {
          const { formula, values } = fields[fieldName];
          filterFormulas.push(formula);
          filters.push({ [fieldName]: values });
        }

        const params = {
          filterByFormula: `OR(${filterFormulas.toString()})`, // collect and apply  all filters
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
        return cachedRecord;
      }

      const wrappedRecord = await loader.load(
        EJSON.stringify({ id: id.toString() }),
      );

      if (ttl) {
        cache.set(cacheKey, wrappedRecord[0], { ttl });
      }

      return wrappedRecord[0];
    },
    findManyByIds: (ids, { ttl } = {}) => {
      return Promise.all(ids.map((id) => methods.findOneById(id, { ttl })));
    },
    findByFields: async (filterFields, { ttl } = {}) => {
      // make all field names map to an array of values to filter with
      const { loaderKey, fieldsToFilters } = mapFieldsToFilters(filterFields);

      // check cache for records found to match this filter
      const cacheKey = cachePrefix + loaderKey;
      const cachedResult = await cache.get(cacheKey);

      // return the cached result
      // if (cachedResult) {
      //   return EJSON.parse(cachedResult);
      // }

      const fieldNames = Object.keys(fieldsToFilters);
      let result;

      result = await loader.load(loaderKey); // load the records that match the given filters { <fieldName>: [<val1> [, ...<vals>]] }

      // if (ttl) {
      //   cache.set(cacheKey, EJSON.stringify(records), { ttl });
      // }

      return result;
    },
    findAll: async ({ ttl } = {}) => {
      // check cache for records
      const cacheKey = cachePrefix + 'all';
      const cachedResult = await cache.get(cacheKey);

      // return the cached result
      if (cachedResult) {
        return cachedResult;
      }

      const wrappedResult = await loader.load('ALL');

      if (ttl) {
        cache.set(cacheKey, wrappedResult, { ttl });
      }

      return wrappedResult;
    },
    deleteFromCacheById: async (id) => {
      loader.clear(EJSON.stringify({ id }));
      const cacheKey = cachePrefix + id.toString();
      await cache.delete(cacheKey);
    },
    deleteFromCacheByFields: async (fields) => {
      const { loaderKey } = mapFieldsToFilters(fields);
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
