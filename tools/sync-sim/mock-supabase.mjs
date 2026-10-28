/**
 * A tiny stand-in for the bits of Supabase the PDF reader talks to while syncing
 * annotations: the PostgREST endpoint (`/rest/v1/<table>`) with the same request shapes
 * supabase-js sends, plus the row level security rules from supabase/schema.sql.
 *
 * It exists so the cross-device sync can be exercised end to end on one machine
 * (`node tools/sync-sim/run.mjs`), with two separate browsers (two jsdom processes),
 * without touching a real project.
 *
 * Env:
 *   SIM_PORT=8787                 port to listen on
 *   SIM_FAIL_WRITES=2             reject that many annotation writes (503) before accepting
 *                                 any, to exercise the reader's automatic retry
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.SIM_PORT || 8787);
let writesToFail = Number(process.env.SIM_FAIL_WRITES || 0);
let writesRejected = 0;

const omitTables = new Set(
  String(process.env.SIM_OMIT_TABLES || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
);
const omitWatchColumns = new Set(
  String(process.env.SIM_OMIT_WATCH_COLUMNS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
);

/** table -> rows */
const tables = new Map(
  [
    ['watch_items', []],
    ['pdf_library', []],
    ['pdf_annotations', []],
    ['lesson_annotations', []],
    ['pdf_trash', []],
    ['pdf_activity', []],
  ].filter(([name]) => !omitTables.has(name)),
);

/** `<bucket>/<path>` -> { userId, size } */
const storageObjects = new Map();

const log = [];
const RESERVED = new Set(['select', 'on_conflict', 'order', 'limit', 'offset', 'columns', 'and', 'or']);

function makeToken(sub) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.${encode('sim-signature')}`;
}

function decodeSub(authorization) {
  const token = String(authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).sub || null;
  } catch {
    return null;
  }
}

function matches(row, filters) {
  return filters.every(([column, op, value]) => {
    if (op === 'eq') return String(row[column]) === value;
    if (op === 'neq') return String(row[column]) !== value;
    if (op === 'in') return value.replace(/[()]/g, '').split(',').includes(String(row[column]));
    if (op === 'is') return value === 'null' ? row[column] === null : row[column] === true;
    return true;
  });
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    ...headers,
  });
  res.end(payload);
}

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function readBody(req) {
  return readRawBody(req).then((buf) => {
    if (!buf.length) return null;
    try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/__log') return send(res, 200, log);
  // Auth endpoints: only what auth-js needs to accept the simulated session.
  if (url.pathname === '/auth/v1/user') {
    const user = decodeSub(req.headers.authorization);
    if (!user) return send(res, 401, { message: 'invalid claim: missing sub claim' });
    return send(res, 200, { id: user, aud: 'authenticated', role: 'authenticated', email: 'sim@focusframe.test' });
  }
  if (url.pathname === '/auth/v1/token') {
    const user = decodeSub(req.headers.authorization) || '11111111-1111-4111-8111-111111111111';
    return send(res, 200, {
      access_token: makeToken(user),
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: 'sim-refresh-token',
      user: { id: user, aud: 'authenticated', role: 'authenticated', email: 'sim@focusframe.test' },
    });
  }
  if (url.pathname === '/__reset') {
    tables.forEach((rows) => { rows.length = 0; });
    storageObjects.clear();
    log.length = 0;
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__state') {
    return send(res, 200, {
      ...Object.fromEntries(tables),
      storage: [...storageObjects.keys()],
    });
  }
  if (url.pathname === '/__writes-rejected') return send(res, 200, { rejected: writesRejected });

  // Storage endpoints (`/storage/v1/object/...`) matching supabase-js StorageFileApi.
  if (url.pathname.startsWith('/storage/v1/object/')) {
    const sub = decodeSub(req.headers.authorization);
    if (!sub && !url.searchParams.has('token')) {
      return send(res, 401, { statusCode: '401', error: 'Unauthorized', message: 'Missing credentials' });
    }
    const rest = decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length));
    if (req.method === 'POST' && rest.startsWith('sign/')) {
      const target = rest.slice('sign/'.length); // `<bucket>/<user>/<file>`
      const parts = target.split('/');
      const owner = parts[1];
      if (owner !== sub || !storageObjects.has(target)) {
        return send(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      }
      return send(res, 200, { signedURL: `/object/sign/${target}?token=sim-signed` });
    }
    if (req.method === 'GET' && rest.startsWith('sign/')) {
      const target = rest.slice('sign/'.length);
      const entry = storageObjects.get(target);
      if (!entry) return send(res, 404, { message: 'Object not found' });
      res.writeHead(200, { 'content-type': 'application/pdf', 'access-control-allow-origin': '*' });
      res.end(entry.bytes);
      return;
    }
    if (req.method === 'DELETE' && !rest.includes('/')) {
      const bucket = rest;
      const body = await readBody(req);
      const prefixes = Array.isArray(body?.prefixes) ? body.prefixes : [];
      const removed = [];
      for (const prefix of prefixes) {
        const clean = String(prefix).replace(/^\/+/, '');
        const owner = clean.split('/')[0];
        const key = `${bucket}/${clean}`;
        if (owner === sub && storageObjects.has(key)) {
          storageObjects.delete(key);
          removed.push({ name: clean });
        }
      }
      return send(res, 200, removed);
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const slash = rest.indexOf('/');
      const bucket = slash > 0 ? rest.slice(0, slash) : '';
      const objectPath = slash > 0 ? rest.slice(slash + 1) : '';
      const owner = objectPath.split('/')[0];
      if (!bucket || owner !== sub) {
        return send(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      }
      const bytes = await readRawBody(req);
      const fullKey = `${bucket}/${objectPath}`;
      storageObjects.set(fullKey, { userId: sub, bytes });
      return send(res, 200, { Id: fullKey, Key: fullKey });
    }
    return send(res, 405, { message: 'Method not allowed' });
  }

  if (!url.pathname.startsWith('/rest/v1/')) {
    return send(res, 404, { message: 'Not found' });
  }

  const table = url.pathname.replace('/rest/v1/', '');
  const rows = tables.get(table);
  if (!rows) {
    // What PostgREST answers when the migration has not been run yet.
    return send(res, 404, {
      code: 'PGRST205',
      details: null,
      hint: "Perhaps you meant the table 'public.pdf_library'",
      message: `Could not find the table 'public.${table}' in the schema cache`,
    });
  }

  const sub = decodeSub(req.headers.authorization);
  if (!sub) {
    return send(res, 401, { code: '401', message: 'Missing or invalid credentials' });
  }

  const filters = [];
  for (const [key, raw] of url.searchParams.entries()) {
    if (RESERVED.has(key)) continue;
    const [op, ...rest] = raw.split('.');
    filters.push([key, op, rest.join('.')]);
  }

  const prefer = String(req.headers.prefer || '');
  const wantsRepresentation = prefer.includes('return=representation');
  const wantsObject = String(req.headers.accept || '').includes('application/vnd.pgrst.object+json');
  const conflictColumns = (url.searchParams.get('on_conflict') || '').split(',').filter(Boolean);

  const withRepresentation = (status, bodyRows) => {
    const visible = bodyRows.map((row) => ({ ...row }));
    log.push({ method: req.method, path: url.pathname + url.search, prefer, status, rows: visible.length });
    if (!wantsRepresentation) return send(res, status, undefined);
    if (wantsObject) {
      if (visible.length !== 1) {
        return send(res, 406, {
          code: 'PGRST116',
          details: `The result contains ${visible.length} rows`,
          hint: null,
          message: 'JSON object requested, multiple (or no) rows returned',
        });
      }
      return send(res, 200, visible[0]);
    }
    return send(res, 200, visible);
  };

  const order = url.searchParams.get('order');
  const applyOrder = (list) => {
    if (!order) return list;
    const [column, direction] = order.split('.');
    const sorted = [...list].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1));
    return direction === 'desc' ? sorted.reverse() : sorted;
  };

  if (req.method === 'GET') {
    if (table === 'watch_items' && omitWatchColumns.size > 0) {
      const requested = String(url.searchParams.get('select') || '')
        .split(',')
        .map((col) => col.trim())
        .filter(Boolean);
      const missingCol = requested.find((col) => omitWatchColumns.has(col));
      if (missingCol) {
        return send(res, 400, {
          code: '42703',
          details: null,
          hint: null,
          message: `column watch_items.${missingCol} does not exist`,
        });
      }
    }
    const visible = rows.filter((row) => row.user_id === sub).filter((row) => matches(row, filters));
    log.push({ method: 'GET', path: url.pathname + url.search, prefer, status: 200, rows: visible.length });
    if (wantsObject) {
      if (visible.length !== 1) {
        return send(res, 406, {
          code: 'PGRST116',
          details: `The result contains ${visible.length} rows`,
          hint: null,
          message: 'JSON object requested, multiple (or no) rows returned',
        });
      }
      return send(res, 200, { ...visible[0] });
    }
    return send(res, 200, applyOrder(visible).map((row) => ({ ...row })));
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    // Simulates a dropped connection / briefly unavailable project.
    if (writesToFail > 0) {
      writesToFail -= 1;
      writesRejected += 1;
      log.push({ method: 'POST', path: url.pathname + url.search, prefer, status: 503, rows: 0 });
      return send(res, 503, { code: '503', message: 'Service Unavailable', details: 'simulated failure' });
    }
    const incoming = Array.isArray(body) ? body : [body];
    if (table === 'watch_items' && omitWatchColumns.size > 0) {
      const missingCol = incoming
        .flatMap((row) => (row ? Object.keys(row) : []))
        .find((col) => omitWatchColumns.has(col));
      if (missingCol) {
        return send(res, 400, {
          code: 'PGRST204',
          details: null,
          hint: null,
          message: `Could not find the '${missingCol}' column of 'watch_items' in the schema cache`,
        });
      }
    }
    if (incoming.some((row) => !row || row.user_id !== sub)) {
      // Same rejection the insert/update policies produce.
      return send(res, 403, {
        code: '42501',
        details: null,
        hint: null,
        message: `new row violates row-level security policy for table "${table}"`,
      });
    }
    const written = [];
    for (const row of incoming) {
      // `updated_at` is the revision stamp the app sends; the mock stores it verbatim,
      // exactly like the schema in supabase/schema.sql.
      const stamped = { ...row };
      if (stamped.updated_at === undefined) stamped.updated_at = new Date().toISOString();
      const existingIndex = conflictColumns.length
        ? rows.findIndex((candidate) => conflictColumns.every((column) => String(candidate[column]) === String(stamped[column])))
        : -1;
      if (existingIndex === -1) {
        rows.push(stamped);
        written.push(stamped);
      } else if (prefer.includes('resolution=ignore-duplicates')) {
        written.push(rows[existingIndex]);
      } else {
        const merged = { ...rows[existingIndex], ...stamped };
        rows[existingIndex] = merged;
        written.push(merged);
      }
    }
    return withRepresentation(201, written);
  }

  if (req.method === 'PATCH') {
    const body = await readBody(req);
    if (table === 'watch_items' && omitWatchColumns.size > 0 && body) {
      const missingCol = Object.keys(body).find((col) => omitWatchColumns.has(col));
      if (missingCol) {
        return send(res, 400, {
          code: 'PGRST204',
          details: null,
          hint: null,
          message: `Could not find the '${missingCol}' column of 'watch_items' in the schema cache`,
        });
      }
    }
    const targets = rows.filter((row) => row.user_id === sub).filter((row) => matches(row, filters));
    for (const row of targets) {
      Object.assign(row, body);
    }
    return withRepresentation(200, targets);
  }

  if (req.method === 'DELETE') {
    const doomed = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.user_id === sub && matches(row, filters));
    for (const { index } of [...doomed].reverse()) rows.splice(index, 1);
    if (table === 'pdf_library' && doomed.length > 0) {
      const deletedPdfIds = new Set(doomed.map(({ row }) => String(row.id)));
      for (const childTable of ['pdf_trash', 'pdf_activity', 'pdf_annotations']) {
        const childRows = tables.get(childTable);
        if (!childRows) continue;
        for (let i = childRows.length - 1; i >= 0; i -= 1) {
          if (deletedPdfIds.has(String(childRows[i].pdf_id))) childRows.splice(i, 1);
        }
      }
    }
    return withRepresentation(204, doomed.map(({ row }) => row));
  }

  return send(res, 405, { message: 'Method not allowed' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-supabase listening on http://127.0.0.1:${PORT}`);
});
