/**
 * render-jobs worker
 *
 * A small render job service. The preview app creates jobs here. Assets are
 * written to R2 and referenced by key. Job records live in D1. Renderer
 * consumers (OpenAI, ComfyUI) read a ready job, render, and write the output
 * back to the same job. That consumer is the next slice and is not wired yet.
 *
 * Routes:
 *   POST /render-jobs                       create a job, store assets, return job_id
 *   GET  /render-jobs/:id                    return the job record + served asset urls
 *   GET  /render-jobs/:id/asset/:name        stream an asset from R2 (locked | output | package)
 *   POST /render-jobs/:id/render             STUB. renderer not wired yet, returns 501.
 *
 * Bindings (see wrangler.jsonc):
 *   DB       D1 database, render_jobs table
 *   RENDERS  R2 bucket for job assets
 *   ALLOWED_ORIGINS  comma separated origin allowlist for browser calls
 */

const JOB_STATUS = {
  READY: 'ready_to_render',
  RENDERING: 'rendering',
  COMPLETE: 'complete',
  ERROR: 'error',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['render-jobs','job_x','asset','locked']

    if (request.method === 'OPTIONS') {
      return preflight(request, env);
    }

    try {
      // POST /render-jobs
      if (request.method === 'POST' && parts.length === 1 && parts[0] === 'render-jobs') {
        return await createJob(request, env);
      }

      // GET /render-jobs/:id
      if (request.method === 'GET' && parts.length === 2 && parts[0] === 'render-jobs') {
        return await getJob(request, env, parts[1]);
      }

      // GET /render-jobs/:id/asset/:name
      if (request.method === 'GET' && parts.length === 4 && parts[0] === 'render-jobs' && parts[2] === 'asset') {
        return await serveAsset(request, env, parts[1], parts[3]);
      }

      // POST /render-jobs/:id/render  (stub)
      if (request.method === 'POST' && parts.length === 3 && parts[0] === 'render-jobs' && parts[2] === 'render') {
        return json(request, env, 501, {
          error: 'renderer_not_wired',
          message: 'The render consumer is the next build slice. This job is stored and ready_to_render.',
          job_id: parts[1],
        });
      }

      return json(request, env, 404, { error: 'not_found' });
    } catch (err) {
      return json(request, env, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
  },
};

/* -------------------------------------------------------------------------- */
/* create                                                                     */
/* -------------------------------------------------------------------------- */

async function createJob(request, env) {
  const contentType = request.headers.get('content-type') || '';
  let pkg;            // the render package object
  let imageBytes;     // Uint8Array of the locked product image
  let imageMediaType; // e.g. image/webp
  let renderer = 'openai';
  let workflow = 'native_composite_v1';

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const rawPkg = form.get('request_json');
    if (typeof rawPkg !== 'string') {
      return json(request, env, 400, { error: 'missing_request_json' });
    }
    pkg = parseJsonOrNull(rawPkg);
    if (!pkg) return json(request, env, 400, { error: 'invalid_request_json' });

    const file = form.get('locked_product_image');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return json(request, env, 400, { error: 'missing_locked_product_image' });
    }
    imageBytes = new Uint8Array(await file.arrayBuffer());
    imageMediaType = file.type || pkgMediaType(pkg) || 'image/webp';

    if (typeof form.get('renderer') === 'string') renderer = form.get('renderer');
    if (typeof form.get('workflow') === 'string') workflow = form.get('workflow');
  } else {
    // JSON convenience path. locked image arrives as base64 (in transit only,
    // never stored as base64: we decode and write bytes to R2).
    const body = await request.json().catch(() => null);
    if (!body) return json(request, env, 400, { error: 'invalid_json_body' });

    pkg = body.request_json || body.package || null;
    if (typeof pkg === 'string') pkg = parseJsonOrNull(pkg);
    if (!pkg) return json(request, env, 400, { error: 'missing_request_json' });

    const b64 = body.locked_product_image_b64 || body.image_b64;
    if (!b64) return json(request, env, 400, { error: 'missing_locked_product_image' });
    imageBytes = base64ToBytes(stripDataUrl(b64));
    imageMediaType = body.media_type || pkgMediaType(pkg) || 'image/webp';

    if (typeof body.renderer === 'string') renderer = body.renderer;
    if (typeof body.workflow === 'string') workflow = body.workflow;
  }

  if (!imageBytes || imageBytes.length === 0) {
    return json(request, env, 400, { error: 'empty_locked_product_image' });
  }

  const jobId = 'job_' + crypto.randomUUID().replace(/-/g, '');
  const ext = extForMedia(imageMediaType);
  const lockedKey = `jobs/${jobId}/locked-product.${ext}`;
  const packageKey = `jobs/${jobId}/render-package.json`;

  // Scrub any inline base64 from the stored package. The stored package
  // references the image by key, so has_image_data is always false at rest.
  const storedPkg = scrubInlineImageData(pkg, lockedKey, imageMediaType);
  const now = new Date().toISOString();

  // Write assets to R2 first, then the job row. If the row write fails, the
  // orphaned assets are harmless and can be swept later.
  await env.RENDERS.put(lockedKey, imageBytes, {
    httpMetadata: { contentType: imageMediaType },
  });
  await env.RENDERS.put(packageKey, JSON.stringify(storedPkg), {
    httpMetadata: { contentType: 'application/json' },
  });

  const meta = storedPkg.meta || {};
  const locked = storedPkg.locked_asset || {};
  const brandName = meta.brand_name || pkg.brand || null;
  const productName = meta.product_name || locked.asset_name || null;
  const selectedAssetUrl = locked.source_image_url || null;
  const productUrl = meta.product_url || null;
  const homeUrl = meta.home_url || null;

  await env.DB.prepare(
    `INSERT INTO render_jobs
       (id, status, product_url, home_url, brand_name, product_name,
        selected_asset_url, locked_product_asset_key, render_package_key,
        renderer, workflow, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    jobId, JOB_STATUS.READY, productUrl, homeUrl, brandName, productName,
    selectedAssetUrl, lockedKey, packageKey,
    renderer, workflow, now, now
  ).run();

  return json(request, env, 201, {
    job_id: jobId,
    status: JOB_STATUS.READY,
    render_package_key: packageKey,
    locked_product_asset_key: lockedKey,
    renderer,
    workflow,
  });
}

/* -------------------------------------------------------------------------- */
/* read                                                                       */
/* -------------------------------------------------------------------------- */

async function getJob(request, env, jobId) {
  const row = await env.DB.prepare(
    `SELECT * FROM render_jobs WHERE id = ?`
  ).bind(jobId).first();

  if (!row) return json(request, env, 404, { error: 'job_not_found', job_id: jobId });

  const base = new URL(request.url).origin;
  const assets = {
    package_url: `${base}/render-jobs/${jobId}/asset/package`,
    locked_product_url: row.locked_product_asset_key
      ? `${base}/render-jobs/${jobId}/asset/locked` : null,
    output_url: row.output_image_key
      ? `${base}/render-jobs/${jobId}/asset/output` : null,
  };

  return json(request, env, 200, {
    ...row,
    render_metadata: safeParse(row.render_metadata),
    assets,
  });
}

async function serveAsset(request, env, jobId, name) {
  const row = await env.DB.prepare(
    `SELECT locked_product_asset_key, render_package_key, output_image_key
       FROM render_jobs WHERE id = ?`
  ).bind(jobId).first();
  if (!row) return json(request, env, 404, { error: 'job_not_found', job_id: jobId });

  const keyMap = {
    locked: row.locked_product_asset_key,
    package: row.render_package_key,
    output: row.output_image_key,
  };
  const key = keyMap[name];
  if (!key) return json(request, env, 404, { error: 'asset_not_available', asset: name });

  const object = await env.RENDERS.get(key);
  if (!object) return json(request, env, 404, { error: 'asset_missing_in_storage', key });

  const headers = corsHeaders(request, env);
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'private, max-age=300');
  return new Response(object.body, { status: 200, headers });
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function parseJsonOrNull(s) {
  try { return JSON.parse(s); } catch { return null; }
}
function safeParse(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return s; }
}
function stripDataUrl(b64) {
  const i = b64.indexOf('base64,');
  return i >= 0 ? b64.slice(i + 'base64,'.length) : b64;
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function pkgMediaType(pkg) {
  return pkg && pkg.locked_asset && pkg.locked_asset.media_type || null;
}
function extForMedia(m) {
  const map = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg' };
  return map[(m || '').toLowerCase()] || 'webp';
}
function scrubInlineImageData(pkg, lockedKey, mediaType) {
  const copy = JSON.parse(JSON.stringify(pkg));
  if (copy.locked_asset && typeof copy.locked_asset === 'object') {
    delete copy.locked_asset.image_b64;
    delete copy.locked_asset.image_data;
    copy.locked_asset.storage_key = lockedKey;
    copy.locked_asset.media_type = copy.locked_asset.media_type || mediaType;
    copy.locked_asset.has_image_data = false;
  }
  return copy;
}

/* -------------------------------------------------------------------------- */
/* cors + json                                                                */
/* -------------------------------------------------------------------------- */

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.includes(origin)) return origin;
  if (origin.endsWith('.workers.dev')) return origin; // allow the dev subdomain during proving
  return list[0] || '*';
}
function corsHeaders(request, env) {
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', allowedOrigin(request, env));
  h.set('Vary', 'Origin');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return h;
}
function preflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}
function json(request, env, status, obj) {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(obj), { status, headers });
}
