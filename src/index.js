/**
 * render-jobs worker
 *
 * A render job service: package delivery plus synchronous render execution.
 * The preview app creates jobs here. Assets are written to R2 and referenced
 * by key. Job records live in D1. The render endpoint runs the OpenAI consumer
 * inline: it reads a ready job, renders against the locked image, writes the
 * output back to R2, and marks the job complete. ComfyUI remains a future
 * backend that would consume ready jobs the same way.
 *
 * Routes:
 *   POST /render-jobs                       create a job, store assets, return job_id
 *   GET  /render-jobs/:id                    return the job record + served asset urls
 *   GET  /render-jobs/:id/asset/:name        stream an asset from R2 (locked | output | package)
 *   POST /render-jobs/:id/render             render with OpenAI, store output, mark complete
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

      // POST /render-jobs/:id/render
      if (request.method === 'POST' && parts.length === 3 && parts[0] === 'render-jobs' && parts[2] === 'render') {
        return await runRender(request, env, parts[1]);
      }

      return json(request, env, 404, { error: 'not_found' });
    } catch (err) {
      return json(request, env, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
  },

  // Queue consumer. Runs decoupled from any client request, so the OpenAI
  // render can take the time it needs. max_batch_size is 1 (see wrangler.jsonc)
  // so each invocation handles one job.
  async queue(batch, env) {
    for (const message of batch.messages) {
      const jobId = message.body && message.body.job_id;
      if (!jobId) { message.ack(); continue; }
      try {
        await renderJobToStorage(jobId, env);
        message.ack();
      } catch (err) {
        const detail = String((err && err.message) || err).slice(0, 300);
        // max_retries is 2, so attempts 1, 2, 3. On the final attempt, record
        // the error on the job so the polling client stops waiting, then ack.
        if (message.attempts >= 3) {
          try { await markJobError(env, jobId, detail); } catch (_) {}
          message.ack();
        } else {
          message.retry();
        }
      }
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

  // Scrub any inline base64 from the stored package and record where the
  // locked image lives, so the at-rest package references the asset by URL
  // with has_image_data false.
  const storedUrl = `${new URL(request.url).origin}/render-jobs/${jobId}/asset/locked`;
  const storedPkg = scrubInlineImageData(pkg, lockedKey, imageMediaType, storedUrl);
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
/* render: enqueue + consume                                                  */
/*                                                                            */
/* The POST /render-jobs/:id/render endpoint enqueues the job and returns      */
/* immediately with status queued, so it never outlives the client request.   */
/* The queue consumer (see the queue handler in the default export) calls      */
/* renderJobToStorage, which runs the proven OpenAI path decoupled from any    */
/* client connection and writes the output back. The browser polls the job    */
/* until status is complete or error.                                          */
/* -------------------------------------------------------------------------- */

async function runRender(request, env, jobId) {
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  const nowIso = () => new Date().toISOString();

  const row = await env.DB.prepare(`SELECT * FROM render_jobs WHERE id = ?`).bind(jobId).first();
  if (!row) return json(request, env, 404, { error: 'job_not_found', job_id: jobId });

  // Return the existing result rather than re-charging OpenAI, unless forced.
  if (row.status === 'complete' && row.output_image_key && !force) {
    return await getJob(request, env, jobId);
  }
  // Already in flight: report status rather than enqueueing a duplicate.
  if ((row.status === 'queued' || row.status === 'rendering') && !force) {
    return json(request, env, 202, { job_id: jobId, status: row.status });
  }
  if (!env.OPENAI_API_KEY) {
    return json(request, env, 500, {
      error: 'openai_key_missing',
      message: 'Set OPENAI_API_KEY as a secret on the render-jobs worker.',
    });
  }

  await env.DB.prepare(
    `UPDATE render_jobs SET status='queued', error_message=NULL, updated_at=? WHERE id=?`
  ).bind(nowIso(), jobId).run();

  await env.RENDER_QUEUE.send({ job_id: jobId });

  return json(request, env, 202, { job_id: jobId, status: 'queued' });
}

// The actual render work, run by the queue consumer. No request context: it
// stores the output key and lets getJob build the served URL at poll time.
// Throws on failure so the consumer can retry.
async function renderJobToStorage(jobId, env) {
  const nowIso = () => new Date().toISOString();
  const row = await env.DB.prepare(`SELECT * FROM render_jobs WHERE id = ?`).bind(jobId).first();
  if (!row) throw new Error('job not found: ' + jobId);
  if (row.status === 'complete' && row.output_image_key) return; // already done

  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY secret not set on the worker');

  await env.DB.prepare(
    `UPDATE render_jobs SET status='rendering', error_message=NULL, updated_at=? WHERE id=?`
  ).bind(nowIso(), jobId).run();

  const pkgObj = await env.RENDERS.get(row.render_package_key);
  if (!pkgObj) throw new Error('render package missing in storage');
  const pkg = JSON.parse(await pkgObj.text());

  const lockedObj = await env.RENDERS.get(row.locked_product_asset_key);
  if (!lockedObj) throw new Error('locked product image missing in storage');
  const lockedBuf = await lockedObj.arrayBuffer();
  const lockedType = lockedObj.httpMetadata?.contentType || pkg?.locked_asset?.media_type || 'image/png';
  const productFile = new File(
    [lockedBuf],
    'locked-product.' + extensionForMediaType(lockedType),
    { type: normalizeMediaType(lockedType) }
  );

  const prompt = buildOpenAINativePrompt(pkg);
  const finalImg = await callOpenAIImageEdit(prompt, productFile, env);

  const outMedia = finalImg.media_type || 'image/png';
  const outputKey = `jobs/${jobId}/output-001.${extensionForMediaType(outMedia)}`;
  await env.RENDERS.put(outputKey, base64ToBytes(finalImg.image_b64), {
    httpMetadata: { contentType: outMedia },
  });

  const meta = {
    provider: finalImg.provider,
    model: finalImg.model,
    requested_size: finalImg.requested_size,
    requested_quality: finalImg.requested_quality,
    requested_output_format: finalImg.requested_output_format,
    prompt_used: prompt,
  };

  await env.DB.prepare(
    `UPDATE render_jobs
       SET status='complete', output_image_key=?, output_image_url=NULL,
           render_metadata=?, error_message=NULL, updated_at=?
     WHERE id=?`
  ).bind(outputKey, JSON.stringify(meta), nowIso(), jobId).run();
}

async function markJobError(env, jobId, detail) {
  await env.DB.prepare(
    `UPDATE render_jobs SET status='error', error_message=?, updated_at=? WHERE id=?`
  ).bind(String(detail || 'render failed').slice(0, 300), new Date().toISOString(), jobId).run();
}

/* -------------------------------------------------------------------------- */
/* OpenAI renderer (ported verbatim from the proven world-preview worker,     */
/* except normalizeMediaType, which was not in the shared snippet and is      */
/* reconstructed here as a trivial normalizer. Verify if behavior matters.)   */
/* -------------------------------------------------------------------------- */

// [RECONSTRUCTED] normalizeMediaType was referenced but not included in the
// shared render function. This is a minimal stand-in, not the original.
function normalizeMediaType(mt) {
  const m = String(mt || '').toLowerCase().trim();
  if (!m) return 'image/png';
  if (m === 'image/jpg') return 'image/jpeg';
  return m;
}

function extensionForMediaType(mt) {
  const m = normalizeMediaType(mt).toLowerCase();
  if (m.includes('webp')) return 'webp';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  return 'png';
}

function cleanWorldPromptForNativeComposite(prompt) {
  return String(prompt || '')
    .replace(/leave clear space for the product\.?/ig, '')
    .replace(/leave clear space\.?/ig, '')
    .replace(/leave room for the product\.?/ig, '')
    .replace(/clear space for the product\.?/ig, '')
    .replace(/clear placement area\.?/ig, '')
    .replace(/empty product zone\.?/ig, '')
    .replace(/product-shaped placement area\.?/ig, '')
    .replace(/placement area\.?/ig, '')
    .replace(/do not draw any product,?\s*/ig, '')
    .replace(/do not draw[^.]*\b(product|can|bottle|package|label|logo|brand name|readable text)[^.]*\./ig, '')
    .replace(/without any product,?\s*/ig, '')
    .replace(/no product,?\s*/ig, '')
    .replace(/no can,?\s*/ig, '')
    .replace(/no bottle,?\s*/ig, '')
    .replace(/no package,?\s*/ig, '')
    .replace(/no label,?\s*/ig, '')
    .replace(/no logo,?\s*/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildOpenAINativePrompt(requestJson) {
  const variants = Array.isArray(requestJson && requestJson.variants) ? requestJson.variants : [];
  const reference = variants.find((v) => v.render_path === 'reference') || {};
  const composite = variants.find((v) => v.render_path === 'composite') || variants[0] || {};

  const world = cleanWorldPromptForNativeComposite(
    composite.positive || reference.positive || requestJson?.prompts?.positive || ''
  );

  const fidelity = requestJson?.fidelity_contract?.rules || [];
  const product =
    requestJson?.meta?.product_name || requestJson?.locked_asset?.asset_name || 'the supplied product';

  const placement = placementProse(requestJson?.placement_spec);

  return [
    'Create one finished premium cinematic brand-world photograph, wide 16:9.',
    'Use the uploaded product image as the exact hero product asset: ' + product + '.',
    placement,
    'The product should feel photographed in the scene, not pasted on top.',
    'Match the scene light direction, shadow softness, lens perspective, reflections, surface contact, and ambient color spill.',
    'Add believable contact shadow under the product.',
    'Do not redraw, retype, recolor, redesign, relabel, reshape, crop, or reinterpret the product packaging.',
    'The label hierarchy, text, logo, can shape, proportions, and colors must remain visually unchanged from the supplied image.',
    'Do not create placeholder boxes, dashed outlines, product placement guides, crop marks, empty product zones, layout frames, labels, signage, QR codes, extra cans, hands, or people.',
    world ? 'Scene direction: ' + world : '',
    fidelity.length ? 'Fidelity rules: ' + fidelity.join(' ') : '',
  ].filter(Boolean).join('\n').replace(/(?:^|\s)0\.(?=\s|$)/g, ' ');
}

// One authoritative placement instruction, derived from the numeric spec so the
// words and the numbers never disagree. The verbal position comes from cx.
function placementProse(spec) {
  spec = spec || {};
  const cx = typeof spec.cx === 'number' ? spec.cx : 0.62;
  const cy = typeof spec.cy === 'number' ? spec.cy : 0.6;
  const w = typeof spec.width_pct === 'number' ? spec.width_pct : 0.24;
  const third = cx <= 0.42 ? 'left third' : (cx >= 0.58 ? 'right third' : 'center');
  const vert = cy >= 0.66 ? 'lower portion' : 'lower-middle';
  const pct = Math.round(w * 100);
  return 'Place the product in the ' + third + ' of the frame, ' + vert +
    ', upright and label facing camera, occupying about ' + pct +
    ' percent of the frame width, as a small but clear hero within the world, not centered and not filling the frame. Keep enough surrounding environment visible to read the world.';
}

async function callOpenAIImageEdit(prompt, productFile, env) {
  const key = env && env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY secret not set on the Worker');

  const model = (env && env.OPENAI_IMAGE_MODEL) || 'gpt-image-2';
  const size = (env && env.OPENAI_IMAGE_SIZE) || '1024x1024';
  const quality = (env && env.OPENAI_IMAGE_QUALITY) || 'medium';
  const outputFormat = (env && env.OPENAI_IMAGE_OUTPUT_FORMAT) || 'png';

  const fd = new FormData();
  fd.append('model', model);
  fd.append('prompt', prompt);
  fd.append('size', size);
  fd.append('quality', quality);
  fd.append('output_format', outputFormat);
  fd.append('image[]', productFile, productFile.name || ('locked-product.' + extensionForMediaType(productFile.type)));

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key },
    body: fd,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const detail = data?.error?.message || text || ('OpenAI image edit ' + res.status);
    throw new Error(detail.slice(0, 300));
  }

  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no b64_json image');

  return {
    image_b64: b64,
    media_type: 'image/' + outputFormat,
    model,
    provider: 'openai',
    requested_size: size,
    requested_quality: quality,
    requested_output_format: outputFormat,
  };
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
function scrubInlineImageData(pkg, lockedKey, mediaType, storedUrl) {
  const copy = JSON.parse(JSON.stringify(pkg));
  if (copy.locked_asset && typeof copy.locked_asset === 'object') {
    delete copy.locked_asset.image_b64;
    delete copy.locked_asset.image_data;
    copy.locked_asset.storage_key = lockedKey;
    if (storedUrl) copy.locked_asset.stored_asset_url = storedUrl;
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
