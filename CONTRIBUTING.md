# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Reporting a mismatch with the real API

The most useful report is a raw response that doesn't match the types. Run `pnpm build && pnpm smoke` (read-only), or capture a webhook body, and open an issue with:

- the endpoint or `notification_type`
- the raw response, with **keys, phone numbers, names and addresses removed**
- what the SDK did with it (the error `kind`, or the wrong value)

Never paste API keys, secret keys or webhook tokens into an issue.

## Setup

Node ≥ 22 and pnpm.

```bash
pnpm install
pnpm test
pnpm type-check
pnpm build
```

CI runs those on Node 22 and 24, then loads the built package on Node 18 and 20, because the runtime supports 18+.

## Rules

- **No runtime dependencies.** Use built-in `fetch` and `node:crypto`.
- **Tests never touch the network.** Inject a fake `fetch` (see `tests/client.test.ts`). Steadfast has no sandbox, so a stray live call books a real parcel.
- **Every behaviour gets a test**, especially error mapping and anything that decides whether a retry is safe.
- **Fail before sending, not after.** Steadfast truncates instead of rejecting, so a limit belongs in `FIELD_LIMITS` and `validateOrder`.
- **Don't reject what you don't recognise in webhooks.** A 4xx is never retried by Steadfast, so rejecting a new status or event type loses it. Pass it through.
- **Keep the README in step** with any change to a public method, type or behaviour, and add a line to `CHANGELOG.md`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …).

## Examples

Files in `examples/` import `steadfast-merchant-sdk` like a user would; `tsconfig.json` maps that to `src/`, so `pnpm type-check` covers them. Keep them runnable.
