# ShopPatch

ShopPatch is a local, live usability study for a sample clothing store. A Tavus PAL interviews a shopper face to face while Raven observes the shared store window. The app also records exact store actions. When the PAL has confirmed a usability problem, a local coding worker edits the store source, checks the build, and publishes the change for an immediate retest. The study report shows what was observed, what the shopper said, and the actual code diff.

## Run locally

Requirements: Node.js 20.19+ or 22.12+, pnpm, a Tavus API key, and a locally signed-in Codex CLI (`codex`). The key is entered in the browser setup screen; do not put it in source control. On this Mac, the bundled Node runtime is available at `/Users/PrakharGoel/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin` if your default Node is older.

```bash
cd /Users/PrakharGoel/Documents/Codex/2026-10-08/loo/outputs/shoppatch
export PATH="/Users/PrakharGoel/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
pnpm install
pnpm dev:all
```

Open <http://127.0.0.1:5173>. The setup screen creates a PAL with Tavus' default Anna face, Raven perception, Magic Canvas, and the study tools. You may supply another Face ID if your Tavus workspace has one. The key stays in the local API process memory; only the PAL and tool IDs are saved under ignored `data/`.

## Demo path

1. Start an interview. Tell the PAL what clothing you want. It can put the store link on Magic Canvas; the study panel also shows the link.
2. Open the store in another tab, share **that tab or window** with the PAL, and shop normally. The catalog has tops, jeans, dresses, jackets, and sweaters. Search, compare, pick a size, and use the simulated checkout. No payment details are collected.
3. Think aloud. The PAL can inspect recent exact store events, use Raven's shared-screen context, and ask neutral follow-up questions. When you finish your first attempt, use the **Finished your first attempt?** control.
4. Once a problem is confirmed, the PAL can call `start_store_repair`. The app launches `codex exec` in an isolated Git worktree, limits edits to `src/store/`, then runs TypeScript and a production build. A verified patch is applied to the running source. Vite hot reloads it.
5. Reload the store, try the same task, and tell the PAL what changed. End the call and open the report.

The app does **not** contain a prebuilt color-filter or size-guide variant. Those may be sensible repairs if a real shopper's actions and words support them. The catalog includes product colors and garment measurements so a coding worker can build honest controls without making up product facts.

## Why a video PAL here

A human researcher would normally sit with a shopper, watch where they look, listen to uncertainty, and ask what they expected at the moment it matters. Tavus gives the study a visible interviewer with turn taking and rapport, while Raven provides live context from the shopper's shared screen. Store telemetry adds precise action data that screen perception alone cannot reliably reconstruct. The app treats clicks as signals to ask about, not proof of confusion.

## Architecture

```text
Browser study room ── Tavus CVI call ── PAL + Raven + Magic Canvas
       │                     │
       │ store events        │ tool calls / utterances
       ▼                     ▼
Local Express API ─── session evidence + repair state
       │
       └── isolated Git worktree → Codex CLI source edit → TS + Vite checks
                                        │
                                        └── verified patch → live store → retest
```

- `src/interview/`: setup, CVI room, screen-share control, Magic Canvas host, event relay.
- `src/store/`: independent storefront and catalog, with instrumented shopping actions.
- `src/report/`: observed actions, participant quotes, repair evidence, and diff.
- `server/tavus.ts`: PAL, skill, tool, and conversation setup.
- `server/repair.ts`: source-edit worker, scope enforcement, verification, publication.
- `server/state.ts`: local session and event storage.

This local demo supports one active repair against one working store checkout at a time. To start a fresh baseline study after a published repair, restore `src/store/` from the initial Git commit. The study data under `data/` is local and ignored by Git.

## Verification status

The storefront, study room setup screen, and report were visually checked locally. The React TypeScript check and Vite production build pass. The local API routes and source-edit worker can be exercised without a Tavus key. A live PAL call, Raven screen perception, Magic Canvas generation, and Tavus tool delivery require entering a valid key in the local setup screen and have not been verified without it.

Tavus references: [PAL creation](https://docs.tavus.io/api-reference/pals/create-pal), [screen share](https://docs.tavus.io/sections/conversational-video-interface/pal/screen-share), [Magic Canvas configuration](https://docs.tavus.io/sections/conversational-video-interface/magic-canvas/api/configuration), [tool delivery](https://docs.tavus.io/sections/conversational-video-interface/pal/llm-tool-delivery).
