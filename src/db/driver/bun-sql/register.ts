import { registerDriver } from "../driver-registry";
import { BunSqlDriver } from "./bun-sql-driver";
import { mariadbDialect, mysqlDialect } from "./mysql-dialect";
import { cockroachdbDialect, postgresDialect, timescaledbDialect } from "./postgres-dialect";

// Importing this module registers the Bun-native SQL driver for the remote engines as a side effect.
// Postgres-wire-protocol family:
registerDriver("postgres", (config) => new BunSqlDriver(config, postgresDialect));
registerDriver("cockroachdb", (config) => new BunSqlDriver(config, cockroachdbDialect));
registerDriver("timescaledb", (config) => new BunSqlDriver(config, timescaledbDialect));
// MySQL-wire-protocol family:
registerDriver("mysql", (config) => new BunSqlDriver(config, mysqlDialect));
registerDriver("mariadb", (config) => new BunSqlDriver(config, mariadbDialect));
