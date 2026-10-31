# Recorder bot

The recorder bot records every telemedicine consultation as an evidence recording. See the spec in issue #2 and the decisions in `docs/adr/0001` to `0005`.

This is a standalone package, like `tests/`. It has its own dependencies, runs on Node, and nothing in it goes into the web bundle.

## Layout

| Path | What |
|---|---|
| `src/consultationLifecycle.ts` | The consultation lifecycle module. It is pure: it takes timestamped events and returns timeline entries and commands (start a timer, cancel a timer, stop). It owns the stop rule and derives staff visits and gaps. |
| `test/` | Unit tests, run with Node's built-in test runner and its mock timers. |

## Commands

Run these from this directory after `npm install`:

```bash
npm test
```

```bash
npm run typecheck
```

The TypeScript sources run directly on Node 22.18 or later, which strips types without a build step. That is why imports name `.ts` files and the sources use only erasable syntax: no `enum`, no `namespace`, no parameter properties.
