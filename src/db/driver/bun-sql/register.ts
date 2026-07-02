import { registerDriver } from "../driver-registry";
import { BunSqlDriver } from "./bun-sql-driver";
import { mysqlDialect } from "./mysql-dialect";
import { postgresDialect } from "./postgres-dialect";

// Importing this module registers the Bun-native SQL driver for the remote engines as a side effect.
registerDriver("postgres", (config) => new BunSqlDriver(config, postgresDialect));
registerDriver("mysql", (config) => new BunSqlDriver(config, mysqlDialect));
