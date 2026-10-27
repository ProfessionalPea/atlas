/**
 * Amazon proof-of-concept runner.
 *   node backend/scripts/amazon-poc.js [links-file] [--max-pages=N] [--only=Name]
 * Prints a per-publisher summary table and writes full raw records to backend/scripts/amazon-poc-output.json
 */
const fs = require('fs');
const path = require('path');
const { scanPublishers } = require('../AmazonScanner');

(async () => {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--')) || path.join(__dirname, 'amazon-links.txt');
  const maxPages = Number((args.find((a) => a.startsWith('--max-pages=')) || '').split('=')[1]) || 30;
  const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];

  let links = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (only) links = links.filter((l) => decodeURIComponent(l).toLowerCase().includes(only.toLowerCase()));

  const t0 = Date.now();
  const { validation, results } = await scanPublishers(links, {
    maxPages,
    concurrency: 1,
    onProgress: (p) => console.log(`  [${p.publisher}] page ${p.page}: ${p.found} unique games (Amazon reports ${p.reportedTotal ?? '?'})`),
    onPublisherDone: (r) => console.log(`✔ ${r.publisher}: ${r.status}${r.statusDetail ? ' (' + r.statusDetail + ')' : ''} - ${r.games.length} games`)
  });

  console.log('\nLink validation: ' + validation.filter((v) => v.valid && !v.duplicate).length + '/' + validation.length + ' valid');
  for (const v of validation.filter((x) => !x.valid || x.duplicate)) console.log('  ✖', v.input, '->', v.error || 'duplicate of #' + v.duplicateOf);

  const rows = results.map((r) => ({
    publisher: r.publisher,
    status: r.status,
    pages: r.pagesRead,
    reported: r.reportedTotal,
    unique: r.stats.total,
    free: r.stats.free,
    paid: r.stats.paid,
    unknown: r.stats.unknown,
    medianPaid: r.stats.medianPaidPrice,
    cur: r.stats.currencies.join('/'),
    avgRating: r.stats.avgRating ? +r.stats.avgRating.toFixed(2) : null,
    reviews: r.stats.totalReviews
  }));
  console.table(rows);

  const tot = rows.reduce((a, r) => ({ unique: a.unique + r.unique, free: a.free + r.free, paid: a.paid + r.paid, unknown: a.unknown + r.unknown }), { unique: 0, free: 0, paid: 0, unknown: 0 });
  console.log('TOTAL', tot, `| parsed-price rate: ${tot.unique ? (((tot.unique - tot.unknown) / tot.unique) * 100).toFixed(1) : 0}% | ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  fs.writeFileSync(path.join(__dirname, 'amazon-poc-output.json'), JSON.stringify({ validation, results }, null, 2));
  console.log('Raw records written to backend/scripts/amazon-poc-output.json');
})();
