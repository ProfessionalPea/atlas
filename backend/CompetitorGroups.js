const { getDatabasePool } = require('./Security');

async function initializeCompetitorGroupsStorage(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS competitor_groups (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL UNIQUE,
      description TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS competitor_group_members (
      group_id INTEGER REFERENCES competitor_groups(id) ON DELETE CASCADE,
      competitor_id INTEGER REFERENCES competitors(id) ON DELETE CASCADE,
      PRIMARY KEY (group_id, competitor_id)
    );
  `);
  console.log('📦 [Competitor Groups] Schema initialized.');
}

/**
 * Resolves a mix of competitors.id and/or play_lists.id / amazon_lists.id to canonical competitors.id
 */
async function resolveCompetitorIds(client, rawIds) {
  if (!Array.isArray(rawIds) || rawIds.length === 0) return [];
  const cleanInputIds = rawIds.map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (cleanInputIds.length === 0) return [];

  const validCompetitorIds = new Set();

  // 1. Direct IDs that match competitors.id
  const { rows: directRows } = await client.query(
    `SELECT id FROM competitors WHERE id = ANY($1::int[])`,
    [cleanInputIds]
  );
  directRows.forEach((r) => validCompetitorIds.add(r.id));

  // 2. Play Lists that have competitor_id pointing to competitors.id
  const { rows: playListRows } = await client.query(
    `SELECT competitor_id FROM play_lists WHERE id = ANY($1::int[]) AND competitor_id IS NOT NULL`,
    [cleanInputIds]
  );
  playListRows.forEach((r) => validCompetitorIds.add(r.competitor_id));

  // 3. Amazon Lists that have competitor_id pointing to competitors.id
  const { rows: amazonListRows } = await client.query(
    `SELECT competitor_id FROM amazon_lists WHERE id = ANY($1::int[]) AND competitor_id IS NOT NULL`,
    [cleanInputIds]
  );
  amazonListRows.forEach((r) => validCompetitorIds.add(r.competitor_id));

  return Array.from(validCompetitorIds);
}

function triggerOverviewInvalidation() {
  try {
    const { invalidatePlayOverviewCache } = require('./PlayStoreIntelligence');
    if (typeof invalidatePlayOverviewCache === 'function') invalidatePlayOverviewCache();
  } catch (_) {}
  try {
    const { invalidateAmazonOverviewCache } = require('./AmazonIntelligence');
    if (typeof invalidateAmazonOverviewCache === 'function') invalidateAmazonOverviewCache();
  } catch (_) {}
}

function registerCompetitorGroupRoutes({ app, pool }) {
  // 1. List all Competitor Groups (Batches)
  app.get('/api/competitor-groups', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const result = await pool.query(`
        SELECT 
          g.id,
          g.name,
          g.description,
          g.created_at,
          COALESCE(
            json_agg(
              json_build_object('id', c.id, 'name', c.name) ORDER BY c.name
            ) FILTER (WHERE c.id IS NOT NULL),
            '[]'::json
          ) AS competitors,
          COALESCE(
            array_agg(c.id ORDER BY c.id) FILTER (WHERE c.id IS NOT NULL),
            '{}'::integer[]
          ) AS competitor_ids
        FROM competitor_groups g
        LEFT JOIN competitor_group_members gm ON g.id = gm.group_id
        LEFT JOIN competitors c ON gm.competitor_id = c.id
        GROUP BY g.id
        ORDER BY g.name ASC
      `);
      return res.json(result.rows || []);
    } catch (err) {
      console.error('[Competitor Groups GET Error]:', err.message);
      return res.status(500).json({ error: 'Failed to fetch competitor groups: ' + err.message });
    }
  });

  // 2. Create a new Competitor Group (Admin only)
  app.post('/api/competitor-groups', async (req, res) => {
    try {
      const { name, description = '', competitorIds, competitor_ids } = req.body || {};
      const trimmedName = String(name || '').trim();
      const trimmedDesc = description != null ? String(description).trim() : null;
      const rawIds = competitor_ids !== undefined ? competitor_ids : competitorIds;
      if (!trimmedName) {
        return res.status(400).json({ error: 'Group name is required.' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const insertRes = await client.query(
          `INSERT INTO competitor_groups (name, description) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
           RETURNING *`,
          [trimmedName, trimmedDesc]
        );
        const group = insertRes.rows[0];

        const validIds = await resolveCompetitorIds(client, rawIds);
        await client.query(`DELETE FROM competitor_group_members WHERE group_id = $1`, [group.id]);

        for (const cId of validIds) {
          await client.query(
            `INSERT INTO competitor_group_members (group_id, competitor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [group.id, cId]
          );
        }
        await client.query('COMMIT');

        triggerOverviewInvalidation();

        return res.json({ status: 'created', group, id: group.id });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[Competitor Groups POST Error]:', err.message);
      return res.status(500).json({ error: 'Failed to create group: ' + err.message });
    }
  });

  // 3. Update an existing Competitor Group (Admin only)
  app.put('/api/competitor-groups/:id', async (req, res) => {
    try {
      const groupId = Number(req.params.id);
      if (!groupId) return res.status(400).json({ error: 'Invalid group ID.' });

      const { name, description, competitorIds, competitor_ids } = req.body || {};
      const trimmedName = name != null ? String(name).trim() : null;
      const trimmedDesc = description !== undefined ? (description != null ? String(description).trim() : null) : undefined;
      const rawIds = competitor_ids !== undefined ? competitor_ids : competitorIds;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (trimmedName || trimmedDesc !== undefined) {
          await client.query(
            `UPDATE competitor_groups
             SET name = COALESCE($1, name),
                 description = CASE WHEN $2::boolean THEN $3 ELSE description END
             WHERE id = $4`,
            [trimmedName, trimmedDesc !== undefined, trimmedDesc, groupId]
          );
        }

        if (rawIds !== undefined) {
          const validIds = await resolveCompetitorIds(client, rawIds);
          await client.query(`DELETE FROM competitor_group_members WHERE group_id = $1`, [groupId]);
          for (const cId of validIds) {
            await client.query(
              `INSERT INTO competitor_group_members (group_id, competitor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [groupId, cId]
            );
          }
        }
        await client.query('COMMIT');

        triggerOverviewInvalidation();

        return res.json({ status: 'updated', id: groupId });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[Competitor Groups PUT Error]:', err.message);
      return res.status(500).json({ error: 'Failed to update group: ' + err.message });
    }
  });

  // 4. Delete a Competitor Group (Admin only - preserves competitors and their data)
  app.delete('/api/competitor-groups/:id', async (req, res) => {
    try {
      const groupId = Number(req.params.id);
      if (!groupId) return res.status(400).json({ error: 'Invalid group ID.' });

      await pool.query(`DELETE FROM competitor_groups WHERE id = $1`, [groupId]);
      triggerOverviewInvalidation();
      return res.json({ status: 'deleted', id: groupId });
    } catch (err) {
      console.error('[Competitor Groups DELETE Error]:', err.message);
      return res.status(500).json({ error: 'Failed to delete group: ' + err.message });
    }
  });
}

module.exports = {
  initializeCompetitorGroupsStorage,
  registerCompetitorGroupRoutes
};
