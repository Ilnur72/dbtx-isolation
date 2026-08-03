-- Schema for the integration tests. Deliberately small, but it carries the
-- three things the tests need: a sequence (id = 1 assertions), a unique
-- constraint (to drive a connection into the aborted 'E' state) and a foreign
-- key (so TRUNCATE has to cascade).

DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS _prisma_migrations;

CREATE TABLE users (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE orders (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users (id),
  total numeric(10, 2) NOT NULL DEFAULT 0
);

-- Stands in for an ORM's migration bookkeeping. The database strategy must
-- leave this alone: an ORM that finds it empty concludes that no migration has
-- ever run.
CREATE TABLE _prisma_migrations (
  id text PRIMARY KEY,
  migration_name text NOT NULL
);

INSERT INTO _prisma_migrations (id, migration_name) VALUES ('1', '000_init');
