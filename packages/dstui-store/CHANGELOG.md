# Changelog

All notable changes to this package are documented here.

## [Unreleased]

### Added

- New package: `@oh-my-pi/pi-dstui-store`. Filesystem-backed
  persistence manager that stores DSL module source plus an
  optional `lastState` blob under a single root directory. Names
  are validated against directory traversal and shell metacharacters,
  source/state size is capped, and `loadModule` re-compiles through
  `@oh-my-pi/pi-dstui` so corrupt blobs surface as compile errors
  rather than silent state corruption. Chunk 3 of #1564.
