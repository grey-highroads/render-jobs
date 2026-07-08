# render-jobs worker

The render job service: package delivery plus synchronous render execution. The preview
app creates jobs here. Assets go to R2 and are referenced by key. Job records live in D1.
The render endpoint runs the OpenAI consumer inline: it reads a ready job, renders against
the locked image, writes the output back to R2, and marks the job complete. A job sits at
`ready_to_render` between creation and the render call. ComfyUI remains a future backend.

This is a standalone worker. It does not touch the existing `world-preview` worker.

## Deploy (GitHub Actions)

Deploys run in CI. The workflow provisions the D1 database and R2 bucket if they do
not exist, resolves the database id, applies migrations, and deploys. You do not run
any Cloudflare commands locally.

One-time setup:

1. Add your Cloudflare API token as a repo secret named `CLOUDFLARE_API_TOKEN`
   under Settings > Secrets and variables > Actions. The token needs Workers Scripts
   Edit, D1 Edit, Workers R2 Storage Edit, and account read.
2. Trigger the workflow: push to `main`, or open the Actions tab and run `deploy`
   via the Run workflow button.

Every push to `main` deploys after that.

After the first successful run the worker lives at
`https://render-jobs.<your-subdomain>.workers.dev`. Your other workers use the
`grey-4fe` subdomain, so it is probably `https://render-jobs.grey-4fe.workers.dev`.
Confirm from the workflow log. [ASSUMED subdomain, verify]

### Why the id is resolved in CI rather than auto-provisioned

Leaving `database_id` blank and letting `wrangler deploy` auto-provision does create the
database, but `d1 migrations apply` then cannot resolve it by name on a remote deploy,
and the generated id is never written back to the repo from CI. So the workflow creates
the database, reads its real id with `d1 list --json`, injects it into `wrangler.jsonc`
at build time, then migrates and deploys. `scripts/extract-d1-id.mjs` does the id lookup.

### Manual deploy (optional fallback)

If you ever want to deploy by hand instead of CI:

```bash
export CLOUDFLARE_API_TOKEN=<your token>
npx wrangler d1 create render-jobs         # copy the id into wrangler.jsonc
npx wrangler r2 bucket create higher-roads-renders
npx wrangler d1 migrations apply render-jobs --remote
npx wrangler deploy
```

## Smoke test without the frontend

This proves create and read end to end using a 1x1 test image. Swap in your worker URL.

```bash
JOBS=https://render-jobs.grey-4fe.workers.dev

# Create a job (JSON convenience path, base64 decoded and stored as bytes)
curl -s -X POST "$JOBS/render-jobs" \
  -H 'Content-Type: application/json' \
  -d '{
    "request_json": {
      "meta": { "product_name": "Test Fizz", "mode": "product_accurate" },
      "locked_asset": { "asset_name": "Test Fizz", "media_type": "image/png", "source_image_url": "https://example.com/x.png" }
    },
    "media_type": "image/png",
    "locked_product_image_b64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  }'
# -> { "job_id": "job_...", "status": "ready_to_render", ... }

# Read it back (use the job_id from above)
curl -s "$JOBS/render-jobs/job_XXXX" | python3 -m json.tool

# The stored package references the image by storage_key with has_image_data:false.
# Fetch the stored package to confirm no base64 was persisted:
curl -s "$JOBS/render-jobs/job_XXXX/asset/package" | python3 -m json.tool
```

You can also confirm in the dashboard: the D1 `render_jobs` table has one row, and R2
`higher-roads-renders` has `jobs/{job_id}/render-package.json` and the locked image.

## Contract

```
POST /render-jobs
  multipart/form-data: request_json (JSON string), locked_product_image (file)
    optional fields: renderer, workflow
  or application/json: { request_json, locked_product_image_b64 | image_b64, media_type, renderer, workflow }
  -> 201 { job_id, status, render_package_key, locked_product_asset_key, renderer, workflow }

GET /render-jobs/:id
  -> 200 { ...job row, render_metadata (parsed), assets:{ package_url, locked_product_url, output_url } }

GET /render-jobs/:id/asset/:name        name in { locked | output | package }
  -> streams the asset from R2 with its content type

POST /render-jobs/:id/render          renders the job with OpenAI, writes output to R2,
                                      flips status to complete, returns the job record.
                                      Synchronous: the render happens inside the request.
                                      ?force=1 re-renders a complete job (re-charges OpenAI).
  -> 200 job record | 409 already_rendering | 500 openai_key_missing | 502 render_failed
```

## Rendering (OpenAI)

The render path is ported from the proven world-preview worker, so output matches what was
already validated: the locked product image is passed as the edit input, and clear-space
language is stripped so the model does not draw placeholder boxes.

One-time secret: add `OPENAI_API_KEY` as a secret on the render-jobs worker. Easiest is the
dashboard: Workers & Pages > render-jobs > Settings > Variables and Secrets > add a Secret
named `OPENAI_API_KEY`. Secrets persist across deploys, so this is a one-time step.

Tunable, non-secret vars live in `wrangler.jsonc`: `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_SIZE`,
`OPENAI_IMAGE_QUALITY`, `OPENAI_IMAGE_OUTPUT_FORMAT`. Defaults match the proven function.
For landscape previews, set `OPENAI_IMAGE_SIZE` to a landscape size the current image model
supports (verify against OpenAI docs or Jim's tests rather than assuming a value).

Synchronous by design for now. If OpenAI latency exceeds the Worker request budget, that is
the trigger to move rendering onto Cloudflare Queues rather than rendering in the request.

## Base64 policy

Base64 is accepted in transit on the JSON create path for convenience, then decoded and
written to R2 as bytes. It is never persisted in the stored package. The create endpoint
strips any inline image data from the package and sets `has_image_data:false` with a
`storage_key` reference. This matches the policy in the build brief.

## Deferred to GA hardening

Auth, per-session caps, rate limiting, cost ceilings, and moving API keys to server secrets
are intentionally out of scope here. The origin allowlist in `vars.ALLOWED_ORIGINS` is
convenience during proving, not a security control.

## Frontend wiring (next turn, after this is deployed)

Once you confirm the worker URL, the preview page changes from sending a synchronous render
to creating a job and polling:

1. Add `const JOBS_ENDPOINT = 'https://render-jobs.grey-4fe.workers.dev';`
2. On render, POST the existing `CURRENT_PKG` as `request_json` plus the locked image blob as
   `locked_product_image` to `POST /render-jobs`, receive `job_id`.
3. Poll `GET /render-jobs/:id` until `status` is `complete`, then show `assets.output_url`.

Until the renderer consumer is wired, the job stays at `ready_to_render`, so the visible
image loop completes only after the OpenAI consumer slice. That is why the frontend edit
waits for that slice rather than shipping a poll that never resolves.
