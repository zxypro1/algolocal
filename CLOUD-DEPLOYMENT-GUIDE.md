# Cloud Deployment Guide / 云端部署指南

> How to run the optional backend: accounts, the problem market, and the deployment tests.
>
> 可选后端的部署方式：账号系统、题目市场，以及配套的部署测试。

---

## What the cloud adds, and what it does not

AlgoLocal works without any of this. Problems, engineering projects, the workshop, practice
history and AI assistance all run on the machine in front of you. The cloud adds exactly three
things:

| Feature | What it needs |
|---|---|
| Accounts | A database and a signing secret |
| Problem market | An account, to publish or star |
| Publishing from the workshop | An account |

Everything else keeps working with no network at all. That is a property the code defends
rather than a claim in a README: `tests/cloud/offline.test.ts` asserts that no cloud request is
issued when the feature is off or the device is offline, and that the practice runtime never
imports cloud or database code.

## Architecture

One Next.js application serves three roles.

| Role | How it runs | What works |
|---|---|---|
| Desktop app | Electron starts the Next server on `localhost:3000` | Everything local; cloud over HTTP to the deployment |
| Local server | `npm start` | Same as the desktop app |
| Web deployment | Vercel | Everything except writing to the local problem library |

The client resolves which backend to talk to at runtime, so the desktop app and the web version
share one codebase and one build:

```
NEXT_PUBLIC_CLOUD_API_BASE   (build time)
  → the address saved in Settings
    → same origin, when the page is served from a real host
      → https://algolocal.vercel.app
```

Authentication uses a bearer token in the `Authorization` header rather than a cookie. The
desktop app calls the deployment cross-origin; cross-site cookies would need `SameSite=None`
plus CSRF handling, and a header has neither problem.

## Setting up a deployment

### 1. Create the database

Any Postgres works, but the code uses Neon's HTTP driver, which is designed for serverless
functions where a connection pool has nowhere to live.

Either use the Neon integration in the Vercel dashboard, or create a project at
[neon.tech](https://neon.tech) and copy the connection string.

### 2. Set the environment variables

In the Vercel project, under Settings → Environment Variables:

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | Yes | The Neon connection string |
| `AUTH_SECRET` | Yes | At least 32 random characters, used to sign tokens and OAuth state |
| `GITHUB_CLIENT_ID` | No | Enables GitHub sign-in |
| `GITHUB_CLIENT_SECRET` | No | Enables GitHub sign-in |
| `CLOUD_PUBLIC_ORIGIN` | No | The public address, if the request headers get it wrong |
| `CLOUD_ALLOWED_ORIGINS` | No | Comma-separated CORS allow list, default `*` |
| `CLOUD_ALLOWED_REDIRECTS` | No | Extra OAuth redirect targets beyond localhost and this deployment |
| `MIGRATION_TOKEN` | No | Enables `POST /api/cloud/admin/migrate` |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Rotating `AUTH_SECRET` signs everybody out, because the stored session hashes no longer match.

### 3. Create the tables

```bash
DATABASE_URL=postgres://... npm run db:migrate
```

Migrations are idempotent and additive: every statement is `IF NOT EXISTS`, and applied
migrations are recorded in `cloud_migrations`. Running it twice is a no-op, and running it
against a database that is already ahead of the code does nothing.

The deploy workflow runs it on every deployment, before the new code goes live. That ordering
matters: a new column that the code needs must exist before the code that reads it is serving
traffic. Since migrations only add, the previous version keeps working against the new schema.

The build also runs `node scripts/db-migrate.js --if-configured`, which skips silently when
`DATABASE_URL` is absent, so a deployment without a database still builds.

### 4. GitHub sign-in (optional)

Create an OAuth App at [github.com/settings/developers](https://github.com/settings/developers).
The callback URL is:

```
https://<your-domain>/api/cloud/auth/github/callback
```

The flow redirects the browser to GitHub and back, then hands the token to the page in the URL
fragment. Fragments are never sent to a server and never appear in access logs or `Referer`
headers; the page consumes it and clears it with `history.replaceState` immediately.

Desktop and web share one code path here. The desktop app is a Chromium window, so it comes
back to `http://localhost:3000/account` the same way a browser does. Loopback addresses are
allowed on any port for exactly this reason; everything else has to be this deployment or an
entry in `CLOUD_ALLOWED_REDIRECTS`, because an unchecked `redirect_uri` is an open redirect
that hands the token to whoever asked for it.

## Local development

Two ways to work on cloud features without deploying anything.

Against a real database:

```bash
echo "DATABASE_URL=postgres://..." >> .env.local
echo "AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" >> .env.local
npm run db:migrate
npm run dev
```

Against an in-process store, when you just want to click through the UI:

```bash
ALGOLOCAL_CLOUD_MEMORY=1 AUTH_SECRET=dev-secret npm run dev
```

The memory store lives in one process and disappears on restart. Vercel refuses to enable it,
because "registration worked but the account was gone the next day" is a worse failure than
"cloud features are unavailable".

Point the client at a different backend from Settings → Cloud features, or bake it in with
`NEXT_PUBLIC_CLOUD_API_BASE`.

## The test system

Four layers, each answering a question the layer below cannot.

| Layer | Command | What it proves |
|---|---|---|
| Unit | `npx jest tests/cloud/auth.test.ts` | Password hashing, token derivation, OAuth state signing, redirect allow list |
| Repository parity | `npx jest tests/cloud/repo.test.ts` | The memory and Postgres implementations behave identically |
| API integration | `npx jest tests/cloud/api.test.ts` | Real routes, real repository, real auth, on every path from register to delete |
| Deployment smoke | `node scripts/smoke-cloud.js <url>` | The connection string, the migrations and the environment variables are actually right |

Run everything the way CI does:

```bash
npm run typecheck
ALGOLOCAL_CLOUD_MEMORY=1 AUTH_SECRET=test npx jest tests/cloud tests/workshop tests/engineering tests/ai tests/editor
npm run build
```

The repository parity suite runs against Postgres too when `DATABASE_URL` is set:

```bash
DATABASE_URL=postgres://... npx jest tests/cloud/repo.test.ts
```

It says so when it skips that half. A test suite that quietly halves its coverage is worse than
one that fails.

The smoke test registers a throwaway account at `@smoke-test.invalid`, publishes a problem,
stars it, downloads it, publishes a second version, then deletes the listing and signs out. It
exits non-zero on the first thing that does not hold, so it can gate a deployment:

```bash
npm run smoke:cloud https://algolocal.vercel.app
```

## Continuous integration

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | Every push and pull request | Typecheck, all test suites, preset project verification, production build |
| `deploy-cloud.yml` | Push to `main` | Migrate, deploy to Vercel, smoke test the deployment and then the production domain |
| `release.yml` | A `v*` tag | Build and publish the desktop applications |
| `deploy-pages.yml` | Changes under `docs/` | Publish the marketing site |

`deploy-cloud.yml` needs four repository secrets: `DATABASE_URL`, `VERCEL_TOKEN`,
`VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`. The last two come from `.vercel/project.json` after
running `vercel link` locally.

CI runs on Node 20, matching the release workflow. npm resolves peer and optional dependencies
differently across major versions, so a lockfile that installs cleanly on one and not the other
is a real failure mode, and one that only shows up at build time.

## The API

All routes live under `/api/cloud`. Errors carry a machine-readable code so the client can
decide what to show without matching English strings.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/cloud/health` | - | Capabilities of this deployment |
| POST | `/api/cloud/auth/register` | - | Create an account |
| POST | `/api/cloud/auth/login` | - | Sign in |
| POST | `/api/cloud/auth/logout` | Token | Revoke this session |
| GET | `/api/cloud/auth/me` | Token | Read the profile |
| PATCH | `/api/cloud/auth/me` | Token | Change the display name or password |
| GET | `/api/cloud/auth/github/start` | - | Begin the OAuth flow |
| GET | `/api/cloud/auth/github/callback` | - | Finish it |
| GET | `/api/cloud/market` | Optional | Search and browse |
| GET | `/api/cloud/market/{slug}` | Optional | Full detail, including the payload |
| DELETE | `/api/cloud/market/{slug}` | Token | Remove your own listing |
| POST | `/api/cloud/market/publish` | Token | Publish or update |
| POST | `/api/cloud/market/{slug}/star` | Token | Star |
| DELETE | `/api/cloud/market/{slug}/star` | Token | Unstar |
| POST | `/api/cloud/market/{slug}/download` | Optional | Fetch the content and count a download |
| GET | `/api/cloud/market/mine` | Token | Your own listings |
| POST | `/api/cloud/admin/migrate` | Token header | Run migrations by hand |

Health is the only route that works without a database, which is the point of it: a health check
that cannot answer when things are broken is not a health check.

Error codes are `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
`rate_limited`, `cloud_disabled` and `server_error`.

## Schema

| Table | Holds |
|---|---|
| `cloud_users` | Accounts, one row per person, with the scrypt hash and the linked GitHub id |
| `cloud_sessions` | Live tokens, stored as `HMAC(AUTH_SECRET, token)` |
| `cloud_listings` | Published problems and projects, with the current payload and counters |
| `cloud_listing_versions` | Every previous payload, keyed by listing and version |
| `cloud_stars` | One row per person per listing |
| `cloud_migrations` | Which migrations have run |

Publishing runs as a single statement with CTEs, so the version bump and the history row cannot
come apart under concurrent writes. The `ON CONFLICT` clause carries an ownership check, which
is why a second author gets a suffixed slug instead of overwriting the first.

## Operating notes

**Payload size.** A listing is capped at 2MB. An engineering project with hidden specs and
reference implementations runs a few hundred KB, so the ceiling is generous, but it exists.

**Rate limits.** Registration, login, publishing and downloads are throttled per instance. On
serverless that is per instance rather than global, so it stops a person clicking twenty times,
not a distributed attack. The real cost to an attacker is scrypt.

**Downloaded code runs locally.** Every listing carries test cases and a reference solution, and
running it executes that code on the reader's machine, inside the same WASM sandbox and Web
Worker their own code runs in. The detail page says so. The sandbox is the security boundary;
scanning uploads for `eval` would only produce false confidence and false positives.

**Read-only deployments.** On Vercel the filesystem is read-only, so routes that write to the
local library return 501 with `code: "read_only_library"` rather than an EROFS stack trace. The
UI asks `/api/environment` up front and offers "Export JSON" instead of "Install locally".

## Troubleshooting

**Health says `database: false`.** `DATABASE_URL` is not visible to the running function. Check
which environments the variable is set for in Vercel, and redeploy after adding it. Environment
variables are read at runtime, but a deployment created before the variable existed will not
have it.

**Health says `accounts: false` but `database: true`.** `AUTH_SECRET` is missing. Without it
there is nothing to sign tokens with.

**`relation "cloud_users" does not exist`.** The migration has not run against this database.
Run `npm run db:migrate` with the same connection string the deployment uses.

**GitHub sign-in returns `redirect_uri is not allowed`.** The address the app tried to come back
to is neither loopback nor this deployment. Add it to `CLOUD_ALLOWED_REDIRECTS`.

**GitHub sign-in returns `The redirect_uri MUST match`.** The callback registered in the OAuth
App does not match what the server computed. Set `CLOUD_PUBLIC_ORIGIN` to the exact public
address.

**Everything is 401 right after a deploy.** `AUTH_SECRET` changed. Stored session hashes are
derived from it, so every existing token stops validating. Signing in again fixes it.
