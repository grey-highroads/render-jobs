// Reads `wrangler d1 list --json` (or `d1 info --json`) from stdin and prints
// the database uuid for the given name. Exits nonzero if it cannot be found.
// Defensive on purpose: wrangler may print a banner before the JSON, and the
// id field has been named uuid / id / database_id across versions.

const name = process.argv[2];
let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (s += d));
process.stdin.on('end', () => {
  const start = s.search(/[\[{]/);
  const jsonText = start >= 0 ? s.slice(start) : s;
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    console.error('Could not parse wrangler JSON output:\n' + s);
    process.exit(1);
  }
  const wasArray = Array.isArray(data) || Array.isArray(data.result);
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data.result)
    ? data.result
    : [data];
  let match = list.find((d) => (d.name || d.database_name) === name);
  // Only fall back to the sole item when the input was a single object
  // (the `d1 info <name>` shape, which is already scoped to our database).
  if (!match && !wasArray && list.length === 1) match = list[0];
  const id = match && (match.uuid || match.database_id || match.id);
  if (!id) {
    console.error(`Could not find database id for "${name}" in:\n` + s);
    process.exit(1);
  }
  process.stdout.write(String(id));
});
