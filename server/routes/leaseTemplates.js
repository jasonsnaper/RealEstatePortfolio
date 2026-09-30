const { sendJson } = require('../lib/router');
const { requireAuth, logAudit } = require('../lib/helpers');
const {
  PLACEHOLDERS, listTemplatesForOwner, createTemplate, updateTemplate, deleteTemplate, duplicateTemplate, serializeTemplate,
} = require('../lib/leaseTemplates');

function registerLeaseTemplateRoutes(router, { db }) {
  // The set of {{tokens}} a template body may use — surfaced so the template
  // editor UI can offer an "insert field" helper instead of the owner having
  // to memorize/guess the exact token spelling.
  router.get('/api/lease-templates/placeholders', async (req, res) => {
    requireAuth(db, req);
    sendJson(res, 200, PLACEHOLDERS);
  });

  router.get('/api/lease-templates', async (req, res) => {
    const owner = requireAuth(db, req);
    sendJson(res, 200, listTemplatesForOwner(db, owner.id).map(serializeTemplate));
  });

  router.post('/api/lease-templates', async (req, res) => {
    const owner = requireAuth(db, req);
    const template = createTemplate(db, owner.id, req.body || {});
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'create_lease_template', entityType: 'lease_template', entityId: template.id });
    sendJson(res, 201, serializeTemplate(template));
  });

  router.put('/api/lease-templates/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const template = updateTemplate(db, owner.id, req.params.id, req.body || {});
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'update_lease_template', entityType: 'lease_template', entityId: template.id });
    sendJson(res, 200, serializeTemplate(template));
  });

  router.delete('/api/lease-templates/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    deleteTemplate(db, owner.id, req.params.id);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'delete_lease_template', entityType: 'lease_template', entityId: Number(req.params.id) });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/lease-templates/:id/duplicate', async (req, res) => {
    const owner = requireAuth(db, req);
    const copy = duplicateTemplate(db, owner.id, req.params.id, req.body || {});
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'duplicate_lease_template', entityType: 'lease_template', entityId: copy.id });
    sendJson(res, 201, serializeTemplate(copy));
  });
}

module.exports = { registerLeaseTemplateRoutes };
