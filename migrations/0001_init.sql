-- render_jobs service, initial schema
-- One row per render job. Assets (package JSON, locked product image, outputs)
-- live in R2 and are referenced here by key, never embedded.

CREATE TABLE IF NOT EXISTS render_jobs (
  id                        TEXT PRIMARY KEY,
  status                    TEXT NOT NULL DEFAULT 'ready_to_render',
  product_url               TEXT,
  home_url                  TEXT,
  brand_name                TEXT,
  product_name              TEXT,
  selected_asset_url        TEXT,
  locked_product_asset_key  TEXT,
  render_package_key        TEXT,
  renderer                  TEXT,
  workflow                  TEXT,
  output_image_key          TEXT,
  output_image_url          TEXT,
  error_message             TEXT,
  render_metadata           TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

-- Supports the future consumer query: next ready job for a given renderer.
CREATE INDEX IF NOT EXISTS idx_render_jobs_status
  ON render_jobs (status);
CREATE INDEX IF NOT EXISTS idx_render_jobs_renderer_status
  ON render_jobs (renderer, status, created_at);
