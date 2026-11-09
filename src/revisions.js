'use strict';
/** "120-130", "120,125,130-132", "r5 r7:r9" -> the svn -c list "120,125,130-132". Returns null when it does not parse. */
function parseRevisionList(s) {
  const parts = String(s).split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const p of parts) {
    const m = p.replace(/^r/i, '').match(/^(\d+)(?:[-:]r?(\d+))?$/);
    if (!m) return null;
    out.push(m[2] ? `${m[1]}-${m[2]}` : m[1]);
  }
  return out.join(',');
}
module.exports = { parseRevisionList };
