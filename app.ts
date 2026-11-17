// The entry's HTTP server: one Node http server for the four surfaces the suite
// drives — git smart HTTP, REST v3, GraphQL v4 and MCP. The implementation lives in
// ./lib/server.mjs; this file only re-exports its factory, as the starter does.
export { createApp } from './lib/server.mjs';
