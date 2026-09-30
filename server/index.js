const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { openDefaultDatabase, UPLOADS_DIR } = require('./db');
const { Router, handleRequest, sendJson, parseCookies } = require('./lib/router');
const { requireAuth } = require('./lib/helpers');
const { warnIfStorageAtRisk } = require('./lib/storageStatus');

const { registerAuthRoutes } = require('./routes/auth');
const { registerSystemStatusRoutes } = require('./routes/systemStatus');
const { registerPropertyRoutes } = require('./routes/properties');
const { registerBankAccountRoutes } = require('./routes/bankAccounts');
const { registerBankConnectionRoutes } = require('./routes/bankConnections');
const { registerFinancialRoutes } = require('./routes/financials');
const { registerLeaseRoutes } = require('./routes/leases');
const { registerTransactionRoutes } = require('./routes/transactionsAndPortfolio');
const { registerPhotoRoutes } = require('./routes/photos');
const { registerDocumentRoutes } = require('./routes/documents');
const { registerMaintenanceRoutes } = require('./routes/maintenance');
const { registerReminderRoutes } = require('./routes/reminders');
const { registerPaymentLinkRoutes } = require('./routes/paymentLinks');
const { registerTenantPortalRoutes } = require('./routes/tenantPortal');
const { registerMockCheckoutRoutes } = require('./routes/mockCheckout');
const { registerWebhookRoutes } = require('./routes/webhooks');
const { registerSmsWebhookRoutes } = require('./routes/smsWebhooks');
const { registerSampleDataRoutes } = require('./routes/sampleData');
const { registerRenterAuthRoutes } = require('./routes/renterAuth');
const { registerRenterManagementRoutes } = require('./routes/renterManagement');
const { registerRenterPortalRoutes } = require('./routes/renterPortal');
const { registerStatementRoutes } = require('./routes/statements');
const { registerLeaseTemplateRoutes } = require('./routes/leaseTemplates');
const { registerLeaseAgreementRoutes } = require('./routes/leaseAgreements');
const { requireRenterAuth } = require('./lib/renterAuth');
const { renterCanSeeDocument, renterLeaseIds } = require('./lib/renterAccess');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

function readRawBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createApp({ db, port }) {
  const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;
  const router = new Router();

  registerAuthRoutes(router, { db });
  registerSystemStatusRoutes(router);
  registerPropertyRoutes(router, { db });
  registerBankAccountRoutes(router, { db });
  registerBankConnectionRoutes(router, { db });
  registerFinancialRoutes(router, { db });
  registerLeaseRoutes(router, { db });
  registerTransactionRoutes(router, { db });
  registerPhotoRoutes(router, { db });
  registerDocumentRoutes(router, { db });
  registerMaintenanceRoutes(router, { db });
  registerReminderRoutes(router, { db });
  registerPaymentLinkRoutes(router, { db, appBaseUrl });
  registerSampleDataRoutes(router, { db });
  registerTenantPortalRoutes(router, { db, appBaseUrl });
  registerMockCheckoutRoutes(router, { db, port });
  const handleMockWebhook = registerWebhookRoutes(router, { db });
  const handleTwilioStatusWebhook = registerSmsWebhookRoutes(router, { db, appBaseUrl });
  registerRenterAuthRoutes(router, { db, appBaseUrl });
  registerRenterManagementRoutes(router, { db, appBaseUrl });
  registerRenterPortalRoutes(router, { db, appBaseUrl });
  registerStatementRoutes(router, { db });
  registerLeaseTemplateRoutes(router, { db });
  registerLeaseAgreementRoutes(router, { db });

  // The tenant's entry point (from a copied payment link) is just the SPA
  // shell — the page itself reads the token out of the URL and calls the
  // token-scoped /api/portal/:token endpoints to render everything.
  router.get('/pay/link/:token', async (req, res) => {
    fs.readFile(path.join(PUBLIC_DIR, 'tenant.html'), (err, data) => {
      if (err) return sendJson(res, 500, { error: 'Tenant portal page missing' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  });

  function serveStaticFile(res, filePath) {
    fs.readFile(filePath, (err, data) => {
      if (err) { sendJson(res, 404, { error: 'Not found' }); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
    });
  }

  // Resolve read access to an uploaded file two ways: an owner's session
  // cookie (full access to their own properties), or a tenant payment-link
  // token passed as ?token=... (narrow access: only documents explicitly
  // shared with the tenant, or maintenance photos for their property — never
  // the general photo timeline, and never another property's files).
  function authorizeUploadAccess(req, propertyId, kind, filename) {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (token) {
      const link = db.prepare('SELECT * FROM payment_links WHERE token = ?').get(token);
      if (link && link.status === 'active' && new Date(link.expires_at + 'Z').getTime() >= Date.now()) {
        const lease = db.prepare('SELECT * FROM leases WHERE id = ?').get(link.lease_id);
        if (lease && String(lease.property_id) === String(propertyId)) {
          if (kind === 'documents') {
            const doc = db.prepare('SELECT * FROM documents WHERE property_id = ? AND file_path = ? AND is_shared_with_tenant = 1').get(propertyId, filename);
            if (doc) return true;
          } else if (kind === 'maintenance') {
            const photo = db.prepare(`
              SELECT mp.* FROM maintenance_photos mp JOIN maintenance_requests mr ON mr.id = mp.maintenance_request_id
              WHERE mr.property_id = ? AND mp.file_path = ?
            `).get(propertyId, filename);
            if (photo) return true;
          } else if (kind === 'cover') {
            const property = db.prepare('SELECT cover_photo_path FROM properties WHERE id = ?').get(propertyId);
            if (property && property.cover_photo_path === filename) return true;
          }
        }
      }
      // An invalid/expired token falls through to the owner-session check below
      // rather than failing immediately, in case an owner is previewing their
      // own file with a stray ?token= in the URL.
    }

    // A signed-in renter (server/lib/renterAuth.js's separate renter_session
    // cookie — never the owner's) can reach three kinds of file, each via its
    // own explicit check, same narrow spirit as the token branch above: a
    // document actually shared with them (by lease or by name), a maintenance
    // photo on a request filed against their own lease, or a statement the
    // owner has explicitly shared. Never property-wide access to anything.
    try {
      const renter = requireRenterAuth(db, req);
      if (kind === 'documents') {
        const doc = db.prepare('SELECT * FROM documents WHERE property_id = ? AND file_path = ?').get(propertyId, filename);
        if (doc && renterCanSeeDocument(db, renter.id, doc.id)) return true;
      } else if (kind === 'maintenance') {
        const photo = db.prepare(`
          SELECT mp.*, mr.lease_id FROM maintenance_photos mp JOIN maintenance_requests mr ON mr.id = mp.maintenance_request_id
          WHERE mr.property_id = ? AND mp.file_path = ?
        `).get(propertyId, filename);
        if (photo && photo.lease_id && renterLeaseIds(db, renter.id).includes(photo.lease_id)) return true;
      } else if (kind === 'statements') {
        const statement = db.prepare(`
          SELECT ps.* FROM payment_statements ps JOIN leases l ON l.id = ps.lease_id
          WHERE l.property_id = ? AND ps.file_path = ?
        `).get(propertyId, filename);
        if (statement && statement.shared_with_renter && renterLeaseIds(db, renter.id).includes(statement.lease_id)) return true;
      } else if (kind === 'lease-agreements') {
        // A completed agreement's final PDF is visible only to a renter who
        // actually has a lease_signers row on THAT agreement — the same
        // per-agreement scoping as getRenterAgreementOr404, not merely "on
        // this lease" — so a former co-signer removed before a later,
        // unrelated agreement was created on the same lease still can't see it.
        const agreement = db.prepare(`
          SELECT la.* FROM lease_agreements la JOIN leases l ON l.id = la.lease_id WHERE l.property_id = ? AND la.final_pdf_path = ?
        `).get(propertyId, filename);
        if (agreement) {
          const signer = db.prepare('SELECT id FROM lease_signers WHERE agreement_id = ? AND renter_id = ?').get(agreement.id, renter.id);
          if (signer) return true;
        }
      }
      // kind === 'cover': never renter-visible via this path — falls through.
    } catch (e) {
      // No renter session, or it's expired/invalid — fall through to the
      // owner-session check below (or ultimately, denial).
    }

    try {
      const owner = requireAuth(db, req);
      const property = db.prepare('SELECT id FROM properties WHERE id = ? AND owner_id = ?').get(propertyId, owner.id);
      return !!property;
    } catch (e) {
      return false;
    }
  }

  function handleUploadRequest(req, res, pathname) {
    const parts = pathname.split('/').filter(Boolean); // ['uploads','properties','12', maybe 'photos'|'documents'|'maintenance', 'filename']
    if (parts[1] !== 'properties' || !parts[2]) return sendJson(res, 404, { error: 'Not found' });
    const propertyId = parts[2];
    req.cookies = parseCookies(req.headers.cookie);

    let kind, filename;
    if (parts.length === 4) { kind = 'cover'; filename = parts[3]; }
    else if (parts.length === 5) { kind = parts[3]; filename = parts[4]; }
    else return sendJson(res, 404, { error: 'Not found' });

    if (!authorizeUploadAccess(req, propertyId, kind, filename)) {
      return sendJson(res, 401, { error: 'Sign in required to view this file' });
    }

    const subpath = kind === 'cover' ? [String(propertyId), filename] : [String(propertyId), kind, filename];
    const filePath = path.join(UPLOADS_DIR, 'properties', ...subpath);
    const resolvedUploads = path.resolve(UPLOADS_DIR);
    if (!path.resolve(filePath).startsWith(resolvedUploads)) return sendJson(res, 400, { error: 'Invalid path' });
    serveStaticFile(res, filePath);
  }

  return async function app(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/webhooks/mock-provider') {
      const rawBody = await readRawBody(req);
      return handleMockWebhook(req, res, rawBody);
    }
    if (req.method === 'POST' && url.pathname === '/api/webhooks/twilio-sms') {
      const rawBody = await readRawBody(req);
      return handleTwilioStatusWebhook(req, res, rawBody);
    }
    if (url.pathname.startsWith('/uploads/')) return handleUploadRequest(req, res, url.pathname);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/pay/')) return handleRequest(router, req, res);

    // The renter portal's entry point — a separate SPA shell from the owner
    // dashboard's index.html, kept at its own path so a renter's bookmark or
    // an invitation/reset link (which route client-side via a #hash, so the
    // server only ever sees the bare path) always lands on the right app
    // shell rather than the owner dashboard's.
    if (url.pathname === '/renter' || url.pathname.startsWith('/renter/')) {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'renter.html'));
    }

    // Static frontend files. Default to index.html for the root and for any
    // unknown path so client-side routing (e.g. /property?id=1) keeps working.
    let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }
    return serveStaticFile(res, filePath);
  };
}

function startServer(port) {
  const db = openDefaultDatabase();
  const app = createApp({ db, port });
  const server = http.createServer((req, res) => {
    app(req, res).catch((e) => {
      console.error('Fatal request error:', e);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    });
  });
  server.listen(port, () => {
    console.log(`Rental portfolio manager running at http://localhost:${port}`);
    // Checked on every boot, not just once: DATA_DIR/UPLOADS_DIR are read at
    // process start, so this reflects exactly what THIS running process will
    // do the moment it restarts. See server/lib/storageStatus.js.
    const status = warnIfStorageAtRisk();
    if (!status.atRisk) {
      console.log(
        status.likelyEphemeralHost
          ? 'Persistent storage looks configured (DATA_DIR and UPLOADS_DIR both set).'
          : 'Running with the default local data/ and public/uploads paths (fine for localhost).'
      );
    }
  });
  return { server, db };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  startServer(port);
}

module.exports = { createApp, startServer };
