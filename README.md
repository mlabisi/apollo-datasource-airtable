Apollo [data source](https://www.apollographql.com/docs/apollo-server/features/data-sources) for Airtable, heavily inspired by [apollo-datasource-mongodb](https://www.npmjs.com/package/apollo-datasource-mongodb)

```
npm i apollo-datasource-airtable
```

This package uses [DataLoader](https://github.com/graphql/dataloader) for batching and per-request memoization caching. It also optionally (if you provide a `ttl`) does shared application-level caching (using either the default Apollo `InMemoryLRUCache` or the [cache you provide to ApolloServer()](https://www.apollographql.com/docs/apollo-server/features/data-sources#using-memcachedredis-as-a-cache-storage-backend)). It does this for the following methods:

- [`findOneById(id, options)`](#findonebyid)
- [`findManyByIds(ids, options)`](#findmanybyids)
- [`findByFields(fields, options)`](#findbyfields)

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Usage](#usage)
  - [Basic](#basic)
  - [Batching](#batching)
  - [Caching](#caching)
  - [TypeScript](#typescript)
- [API](#api)
  - [findOneById](#findonebyid)
  - [findManyByIds](#findmanybyids)
  - [findByFields](#findbyfields)
    - [Examples](#examples)
  - [deleteFromCacheById](#deletefromcachebyid)
  - [deleteFromCacheByFields](#deletefromcachebyfields)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Usage

### Basic

The basic setup is subclassing `AirtableDataSource` and using the [API methods](#API):

`data-sources/Users.js`

```js
const { AirtableDataSource } = require('apollo-datasource-airtable');
const services = require('../../services');

module.exports.Users = class extends AirtableDataSource {
  constructor() {
    super(services.Airtable.base('users'));
  }
}
```

and:

```js
import Airtable from 'airtable';

import Users from './data-sources/Users.js';

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE);

const server = new ApolloServer({
  typeDefs,
  resolvers,
  dataSources: () => ({
    users: new Users(),
  }),
});
```

Inside the data source, the table is available at `this.table` (e.g. `this.table.select({filterByFormula: ""})`). The request's context is available at `this.context`. For example, if you put the logged-in user's ID on context as `context.currentUserId`:

```js
module.exports.Users = class extends AirtableDataSource {
  ...

  async getPrivateUserData(userId) {
    const isAuthorized = this.context.currentUserId === userId
    if (isAuthorized) {
      const user = await this.findOneById(userId)
      return user && user.privateData
    }
  }
}
```

If you want to implement an initialize method, it must call the parent method:

```js
module.exports.Users = class extends AirtableDataSource {
  initialize(config) {
    super.initialize(config);
    ...
  }
}
```

### Batching

This is the main feature, and is always enabled. Here's a full example:

```js
module.exports.Users = class extends AirtableDataSource {
  ...
  
  getUser(userId) {
    return this.findOneById(userId);
  }
}

module.exports.Posts = class extends AirtableDataSource {
  ...
    
  getPosts(postIds) {
    return this.findManyByIds(postIds);
  }
}

const resolvers = {
  Post: {
    author: (post, _, { dataSources: { users } }) =>
      users.getUser(post.authorId),
  },
  User: {
    posts: (user, _, { dataSources: { posts } }) =>
      posts.getPosts(user.postIds),
  },
};

const server = new ApolloServer({
  typeDefs,
  resolvers,
  dataSources: () => ({
    users: new Users(),
    posts: new Posts(),
  }),
});
```

### Caching

To enable shared application-level caching, you do everything from the above section, and you add the `ttl` (in seconds) option to `findOneById()`:

```js
const MINUTE = 60;

module.exports.Users = class extends AirtableDataSource {
  ...
  
  getUser(userId) {
    return this.findOneById(userId, { ttl: MINUTE });
  }

  updateUserName(userId, newName) {
    this.deleteFromCacheById(userId);
    return this.table.updateOne(
      {
        _id: userId,
      },
      {
        $set: { name: newName },
      },
    );
  }
}

const resolvers = {
  Post: {
    author: (post, _, { users }) => users.getUser(post.authorId),
  },
  Mutation: {
    changeName: (_, { userId, newName }, { users, currentUserId }) =>
      currentUserId === userId && users.updateUserName(userId, newName),
  },
};
```

Here we also call [`deleteFromCacheById()`](#deletefromcachebyid) to remove the user from the cache when the user's data changes. If we're okay with people receiving out-of-date data for the duration of our `ttl`—in this case, for as long as a minute—then we don't need to bother adding calls to `deleteFromCacheById()`.

## API

The type of the `id` argument must match the type used in Airtable, which is a string.

### findOneById

`this.findOneById(id, { ttl })`

Resolves to the found document. Uses DataLoader to load `id`. DataLoader uses `table.select({ filterByFormula: "OR(FIND("targetValue", LOWER(ARRAYJOIN({actualValues}))))>0)`. Optionally caches the document if `ttl` is set (in whole positive seconds).

### findManyByIds

`this.findManyByIds(ids, { ttl })`

Calls [`findOneById()`](#findonebyid) for each id. Resolves to an array of documents.

### findByFields

`this.findByFields(fields, { ttl })`

Resolves to an array of documents matching the passed fields.

`fields` has this type:

```ts
interface Fields {
  [fieldName: string]:
    | string
    | number
    | boolean
    | string
    | (string | number | boolean | string)[];
}
```

#### Examples

```js
// get user by username
// `table.select({ filterByFormula: "OR(FIND("testUser", LOWER(ARRAYJOIN({username}))))>0)`
this.findByFields({
  username: 'testUser',
});

// get all users with either the "gaming" OR "games" interest
// `table.select({ filterByFormula: "OR(FIND("gaming", LOWER(ARRAYJOIN({interests}))))>0, FIND("games", LOWER(ARRAYJOIN({interests})))>0)`
this.findByFields({
  interests: ['gaming', 'games'],
});

// get user by username AND with either the "gaming" OR "games" interest
// `table.select({ filterByFormula: "OR(FIND("testUser", LOWER(ARRAYJOIN({username}))))>0, FIND("gaming", LOWER(ARRAYJOIN({interests}))))>0, FIND("games", LOWER(ARRAYJOIN({interests})))>0)`
this.findByFields({
  username: 'testUser',
  interests: ['gaming', 'games'],
});
```

### deleteFromCacheById

`this.deleteFromCacheById(id)`

Deletes a document from the cache that was fetched with `findOneById` or `findManyByIds`.

### deleteFromCacheByFields

`this.deleteFromCacheByFields(fields)`

Deletes a document from the cache that was fetched with `findByFields`. Fields should be passed in exactly the same way they were used to find with.
