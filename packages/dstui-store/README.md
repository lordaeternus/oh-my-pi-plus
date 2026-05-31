# `@oh-my-pi/pi-dstui-store`

Filesystem-backed persistence for `@oh-my-pi/pi-dstui`. Stores a
named DSL module source plus optional instance state to disk so the
agent can hot-reload components across sessions.

## Usage

```ts
import { DstuiStore } from "@oh-my-pi/pi-dstui-store";

const store = new DstuiStore({ root: "/path/to/dstui-store" });

await store.saveModule("inbox-picker", source);
await store.saveState("inbox-picker", { selectedIndex: 2 });

const entry = await store.loadModule("inbox-picker");
// entry.module is already compiled, entry.state is the last saved blob
```

## Safety

- **Names** are validated with a strict regex (`/^[a-z0-9][a-z0-9_-]{0,63}$/i`).
  Anything else throws `StoreNameError` — no `..`, no `/`, no nul, no spaces.
- **Quotas**: `maxSourceBytes` (default 64 KiB) and `maxStateBytes`
  (default 64 KiB) reject oversized blobs before they reach disk.
- **Compilation** runs through `compileModule` on every load, so a
  corrupted file fails fast instead of feeding a broken AST to the
  runtime.
- **Atomicity**: writes go to a sibling `*.tmp` file first and rename
  on success.

## Attribution

`@oh-my-pi/pi-dstui` itself is derived from
[`unitdhda/pi-dstui`](https://github.com/unitdhda/pi-dstui) (MIT);
the persistence layer here is written from scratch with
omp-specific safety guards.
