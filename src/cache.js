const { DataLoader } = require('dataloader');
const { EJSON } = require('bson');

const mapFieldsToFilters = (filterFields) => {
  const fieldsToFilters = {};

  for (const fieldName in filterFields.sort()) {
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
  fieldsToFilters.map((fieldAndFilters) => {
    results.filter(result => {
      for (const fieldName in fieldAndFilters) { // for each field name
        const filterValues = fieldAndFilters[fieldName]; // get the filter values
        if (typeof filterValues === 'undefined') continue;
        const wrappedFilterValues = Array.isArray(filterValues) ? filterValues.map(val => val.toLowerCase()) : [filterValues.toLowerCase()];

        const resultValue = result[fieldName]; // get the actual values
        if (typeof resultValue === 'undefined') continue;
        const wrappedResultValue = Array.isArray(resultValue) ? resultValue.map(val => val.toLowerCase()) : [resultValue.toLowerCase()];

        let isMatch = false;
        do {
          for (const filterValue of wrappedFilterValues) {
            if (wrappedResultValue.includes(filterValue)) { // check if actual value is one of the filter values
              isMatch = true;
            }
          }
        } while (!isMatch);

        return isMatch;
      }
    });
  });
};

const createCachingMethods = ({ table, cache }) => {
  const loader = new DataLoader(async (keys) => { // `keys` = array of objects when findByFields
    const fieldsToFilters = keys.map(EJSON.parse); // parse each of the data loader keys

    // generate the airtable query parameters
    const fields = fieldsToFilters.reduce((prev, curr) => {

      // consolidate potential duplicates
      const existing = prev.find(
        obj =>
          [...Object.keys(obj)].sort().join() === [...Object.keys(curr)].sort().join(),
        // the existing fields to be filtered === the current fields to be filtered
      );
      const fields = existing || {}; // if we already registered this combo of filters, we'll load up its filter values and append any new ones

      for (const fieldName in curr) {
        if (typeof curr[fieldName] === 'undefined') continue; // if there are no filters for the given field name, skip it
        const wrappedValues = Array.isArray(curr[fieldName]) ? curr[fieldName] : [curr[fieldName]];

        if (!fields[fieldName]) fields[fieldName] = { values: wrappedValues }; // if it's the first time we're seeing this field name, make sure its filter values are wrapped in an array
        else fields[fieldName].values = [...fields[fieldName].values, ...wrappedValues]; // otherwise, add the new values to the existing list of filter values for this field

        const cases = (fields[fieldName]).map((value) => `"${value.toString()}", 1`); // for each filter value, add the case to the airtable switch statement
        fields[fieldName].formula = `(SWITCH({${fieldName}},${cases}, 0))=1`; // once all possible values for this field name have been added to the switch, generate the condition
      }

      return fields;
    }, []);

    const filterFormulas = [];
    const filterValues = [];

    for (const fieldName in fields) {
      const { formula, values } = fields[fieldName];
      filterFormulas.push(formula);
      filterValues.push({ [fieldName]: values });
    }

    const params = {
      filterByFormula: `OR(${filterFormulas.toString()})`, // collect and apply  all filters
      view: 'Grid view',
    };

    const results = [];
    table
      .select(params)
      .eachPage(
        (records, fetchNextPage) => {
          records.forEach((record) => {
            results.push(record._rawJson);
          });

          fetchNextPage();
        },
        (error) => {
          if (error) {
            console.error(error);
          }
        },
      );

    return orderRecords(filterValues, results);
  });

  const cachePrefix = `airtable-${table}-`;

  const methods = {
    findOneById: async (id, { ttl } = {}) => {
      // check cache for record with given id
      const cacheKey = cachePrefix + id.toString();
      const cachedRecord = await cache.get(cacheKey);

      // return the cached result
      if (cachedRecord) {
        return cachedRecord;
      }

      const wrappedRecord = await loader.load({ id: id.toString() });

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
      if (cachedResult) {
        return EJSON.parse(cachedResult);
      }

      const fieldNames = Object.keys(fieldsToFilters);
      let result;

      // if there's only one field...
      if (fieldNames.length === 1) {
        const filters = fieldsToFilters[fieldNames[0]]; // retrieve its array of values to filter with
        const filtersArray = Array.isArray(filters) ? filters : [filters]; // ensure value is wrapped in an array
        const records = await Promise.all(filtersArray.map(filterVal => { // for each individual filter value
            const filter = {}; // create an object
            filters[fieldNames[0]] = filterVal; // { <fieldName>: <filterVal> }
            loader.load(EJSON.stringify(filter));
          }), // load the records that match the given filter
        );

        result = [].concat(...records);
      } else { // if there are multiple fields...
        result = await loader.load(loaderKey); // load the records that match the given filters { <fieldName>: [<val1> [, ...<vals>]] }
      }

      if (ttl) {
        cache.set(cacheKey, EJSON.stringify(records), { ttl });
      }

      return result;
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
