# Setup

## Local development

Requirements:

- Node.js 22.12 or later in the Node 22 line; pnpm 10; Git.
- A Tavus account/API key for interviews.
- An installed, authenticated Codex CLI with access to the configured worker model.
- FFmpeg on `PATH` for friction clips.
- Chromium through Playwright if using optional browser checks or the evaluation suite.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

Set `LOOP_CODEX_BIN` in `.env` to the absolute path returned by `command -v codex`. The code's default is `~/.local/bin/codex`. `LOOP_WORKER_MODEL` defaults to `gpt-5.6-luna`; override it with a model available to your account if needed. Worker reasoning is configured as low in `server/repair.ts`.

```bash
pnpm dev:all
```

Open `http://127.0.0.1:5173`. The API runs on port 3001. Enter your Tavus key in the local setup screen; setup provisions/updates the PAL and its tools. The local UI-entered key stays in process memory, so re-enter it after an API restart. An ignored environment variable `TAVUS_API_KEY` is also supported, but the PAL still needs to be configured.

The demo never requires real card details. Screen sharing should target the store tab/window, while the interview tab stays open.

## Native Tavus knowledge retrieval

For a first local run, `.env.example` sets `LOOP_DISABLE_TAVUS_KNOWLEDGE=1`. This permits interviews without a public document URL; the knowledge-base portion is unavailable in that mode.

To enable it:

1. Expose the app's `/knowledge-base/past-user-issues.csv` route at a public HTTPS origin that Tavus can fetch, using your own deployment or tunnel.
2. Set `LOOP_PUBLIC_ORIGIN` to that origin. It is also used when constructing study links, so the origin must reach the app, not just a standalone file host.
3. Remove `LOOP_DISABLE_TAVUS_KNOWLEDGE=1` and restart the API.
4. Start a study to provision the document. If processing is pending, wait and try again. Only a document marked ready is attached.

The CSV is intentionally synthetic and public. Do not replace it with private participant research without changing the document delivery mechanism. Document metadata is saved in ignored `data/tavus-knowledge.json`. Changes to the source or account cause reprovisioning. Default retrieval is used because `speed` stalled voice turns during this project's integration testing.

## Optional warm remote worker

Set both:

```dotenv
LOOP_WORKER_SSH_HOST=your-worker-ssh-alias
LOOP_WORKER_REMOTE_ROOT=/opt/loop-worker
```

Configure SSH, provision dependencies, and authenticate Codex separately on that machine. No silent local fallback is used if remote execution fails. Read [worker operations](../scripts/remote-worker/README.txt) before using the bootstrap/deploy scripts; they assume dedicated machines and specific SSH aliases.

## Hosting

The current demo uses a Google Compute Engine app VM, a separate worker VM, Caddy for HTTPS, and private Google Cloud Storage buckets. GitHub Pages alone cannot host this backend, worker, media processing, or persistent study state.

Hosting is an explicit operational step, separate from pushing to GitHub. There is no automatic deployment workflow in this repository.

Relevant environment settings:

| Setting | Purpose |
| --- | --- |
| `LOOP_HOSTED=1` | Enables hosted access and store artifact behavior. |
| `LOOP_PUBLIC_ORIGIN` | Public HTTPS app origin and document source. |
| `LOOP_COOKIE_SECRET` | At least 32 characters; signs visitor identities. |
| `LOOP_STORE_BUCKET` | Private verified store artifacts. |
| `LOOP_CLIPS_BUCKET` | Private friction clips. |
| `LOOP_WORKER_SSH_HOST`, `LOOP_WORKER_REMOTE_ROOT` | Dedicated worker transport. |
| `TAVUS_API_KEY` | Server-side Tavus credential, when supplied through the environment. |

Hosted setup is managed on the server. Existing deployments can persist the key in protected `data/hosted-tavus.json`; never add that file to Git. Browser `/api/setup` is blocked in hosted mode. PAL provisioning still uses `configureTavus` in `server/tavus.ts` from the trusted server environment. The bootstrap scripts are deployment examples, not a one-command installer for a new cloud project.

## Data and cleanup

`data/` contains study state, clips, snapshots, document IDs, and diagnostics. `.repairs/` contains temporary workspaces. Both are ignored by Git. Ending a study cancels queued/running work and restores its store state. Closing or backing out of the interview ends it; a missed close notification falls back to heartbeat expiry.
