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

    -- Enforce strict 1-batch-per-competitor rule: deduplicate any legacy multi-batch rows first
    DELETE FROM competitor_group_members gm1
    USING competitor_group_members gm2
    WHERE gm1.competitor_id = gm2.competitor_id
      AND gm1.group_id > gm2.group_id;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_competitor_group_members_unique_comp
      ON competitor_group_members(competitor_id);
  `);
  console.log('📦 [Competitor Groups] Schema initialized (1 batch per competitor enforced).');
}

/**
 * Resolves incoming competitor identifiers to canonical competitors.id.
 * Options:
 * - source: 'play_list' | 'amazon_list' | 'competitor' | 'auto'
 */
async function resolveCompetitorIds(client, rawIds, source = 'auto') {
  if (!Array.isArray(rawIds) || rawIds.length === 0) return [];
  const cleanInputIds = [...new Set(rawIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (cleanInputIds.length === 0) return [];

  const validCompetitorIds = new Set();

  if (source === 'play_list') {
    const { rows } = await client.query(
      `SELECT competitor_id FROM play_lists WHERE id = ANY($1::int[]) AND competitor_id IS NOT NULL`,
      [cleanInputIds]
    );
    rows.forEach((r) => validCompetitorIds.add(Number(r.competitor_id)));
    return Array.from(validCompetitorIds);
  }

  if (source === 'amazon_list') {
    const { rows } = await client.query(
      `SELECT id, name, competitor_id FROM amazon_lists WHERE id = ANY($1::int[])`,
      [cleanInputIds]
    );
    for (const row of rows) {
      if (row.competitor_id) {
        validCompetitorIds.add(Number(row.competitor_id));
      } else if (row.name) {
        const cleanName = String(row.name).trim();
        const existingComp = await client.query(
          `SELECT id FROM competitors WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1`,
          [cleanName]
        );
        let compId = existingComp.rows[0]?.id ? Number(existingComp.rows[0].id) : null;
        if (!compId) {
          const compRes = await client.query(
            `INSERT INTO competitors (name) VALUES ($1) RETURNING id`,
            [cleanName]
          );
          compId = Number(compRes.rows[0].id);
        }
        await client.query(`UPDATE amazon_lists SET competitor_id = $1 WHERE id = $2`, [compId, row.id]);
        validCompetitorIds.add(compId);
      }
    }
    return Array.from(validCompetitorIds);
  }

  // Default ('competitor' or 'auto'): check direct competitors.id first; only fall back to play_lists for IDs not in competitors
  const { rows: directRows } = await client.query(
    `SELECT id FROM competitors WHERE id = ANY($1::int[])`,
    [cleanInputIds]
  );
  const matchedDirect = new Set(directRows.map((r) => Number(r.id)));
  matchedDirect.forEach((id) => validCompetitorIds.add(id));

  const remainingIds = cleanInputIds.filter((id) => !matchedDirect.has(id));
  if (remainingIds.length > 0) {
    const { rows: playListRows } = await client.query(
      `SELECT competitor_id FROM play_lists WHERE id = ANY($1::int[]) AND competitor_id IS NOT NULL`,
      [remainingIds]
    );
    playListRows.forEach((r) => validCompetitorIds.add(Number(r.competitor_id)));
  }

  return Array.from(validCompetitorIds);
}

/**
 * Checks whether any of the target canonical competitor IDs are already assigned to a DIFFERENT group.
 */
async function findConflictingBatchMemberships(client, competitorIds, excludeGroupId = null) {
  if (!Array.isArray(competitorIds) || competitorIds.length === 0) return [];
  const params = [competitorIds];
  let query = `
    SELECT gm.competitor_id, c.name AS competitor_name, g.id AS group_id, g.name AS group_name
    FROM competitor_group_members gm
    JOIN competitors c ON c.id = gm.competitor_id
    JOIN competitor_groups g ON g.id = gm.group_id
    WHERE gm.competitor_id = ANY($1::int[])
  `;
  if (excludeGroupId) {
    params.push(Number(excludeGroupId));
    query += ` AND gm.group_id <> $2`;
  }
  query += ` ORDER BY c.name ASC`;
  const { rows } = await client.query(query, params);
  return rows;
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
      const { name, description = '', competitorIds, competitor_ids, idSource } = req.body || {};
      const trimmedName = String(name || '').trim();
      const trimmedDesc = description != null ? String(description).trim() : null;
      const rawIds = competitor_ids !== undefined ? competitor_ids : competitorIds;
      if (!trimmedName) {
        return res.status(400).json({ error: 'Group name is required.' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existingGroupRes = await client.query(
          `SELECT id FROM competitor_groups WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1`,
          [trimmedName]
        );
        if (existingGroupRes.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `A competitor batch named "${trimmedName}" already exists.` });
        }

        const validIds = await resolveCompetitorIds(client, rawIds, idSource || 'auto');
        const conflicts = await findConflictingBatchMemberships(client, validIds, null);
        if (conflicts.length > 0) {
          await client.query('ROLLBACK');
          const detail = conflicts
            .map((c) => `"${c.competitor_name}" (already in batch "${c.group_name}")`)
            .join(', ');
          return res.status(409).json({
            error: `Each competitor can only belong to one batch. Conflict: ${detail}.`
          });
        }

        const insertRes = await client.query(
          `INSERT INTO competitor_groups (name, description) VALUES ($1, $2) RETURNING *`,
          [trimmedName, trimmedDesc]
        );
        const group = insertRes.rows[0];

        for (const cId of validIds) {
          await client.query(
            `INSERT INTO competitor_group_members (group_id, competitor_id) VALUES ($1, $2)`,
            [group.id, cId]
          );
        }
        await client.query('COMMIT');

        triggerOverviewInvalidation();

        return res.json({ status: 'created', group, id: group.id });
      } catch (e) {
        await client.query('ROLLBACK');
        if (e.code === '23505') {
          return res.status(409).json({
            error: e.constraint === 'idx_competitor_group_members_unique_comp'
              ? 'One or more selected competitors already belong to another batch.'
              : `A competitor batch named "${trimmedName}" already exists.`
          });
        }
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

      const { name, description, competitorIds, competitor_ids, idSource } = req.body || {};
      const trimmedName = name != null ? String(name).trim() : null;
      const trimmedDesc = description !== undefined ? (description != null ? String(description).trim() : null) : undefined;
      const rawIds = competitor_ids !== undefined ? competitor_ids : competitorIds;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existsRes = await client.query('SELECT id, name FROM competitor_groups WHERE id = $1', [groupId]);
        if (existsRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Competitor batch not found.' });
        }

        if (rawIds !== undefined) {
          const validIds = await resolveCompetitorIds(client, rawIds, idSource || 'auto');
          const conflicts = await findConflictingBatchMemberships(client, validIds, groupId);
          if (conflicts.length > 0) {
            await client.query('ROLLBACK');
            const detail = conflicts
              .map((c) => `"${c.competitor_name}" (already in batch "${c.group_name}")`)
              .join(', ');
            return res.status(409).json({
              error: `Each competitor can only belong to one batch. Conflict: ${detail}.`
            });
          }

          await client.query(`DELETE FROM competitor_group_members WHERE group_id = $1`, [groupId]);
          for (const cId of validIds) {
            await client.query(
              `INSERT INTO competitor_group_members (group_id, competitor_id) VALUES ($1, $2)`,
              [groupId, cId]
            );
          }
        }

        if (trimmedName || trimmedDesc !== undefined) {
          await client.query(
            `UPDATE competitor_groups
             SET name = COALESCE($1, name),
                 description = CASE WHEN $2::boolean THEN $3 ELSE description END
             WHERE id = $4`,
            [trimmedName, trimmedDesc !== undefined, trimmedDesc, groupId]
          );
        }

        await client.query('COMMIT');

        triggerOverviewInvalidation();

        return res.json({ status: 'updated', id: groupId });
      } catch (e) {
        await client.query('ROLLBACK');
        if (e.code === '23505') {
          return res.status(409).json({
            error: e.constraint === 'idx_competitor_group_members_unique_comp'
              ? 'One or more selected competitors already belong to another batch.'
              : `A competitor batch named "${trimmedName}" already exists.`
          });
        }
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
