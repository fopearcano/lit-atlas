#!/usr/bin/env node
// Integrity checks for the atlas dataset. Run: npm test
const data = require("../js/data.js");

const errors = [];
const ids = new Set();
const regionIds = new Set(data.regions.map((r) => r.id));
const conceptIds = new Set(data.concepts.map((c) => c.id));
const valueIds = new Set(data.values.map((v) => v.id));
const linkTypes = new Set(["influence", "response", "kinship"]);

for (const b of data.books) {
  if (ids.has(b.id)) errors.push(`duplicate book id: ${b.id}`);
  ids.add(b.id);
  if (!regionIds.has(b.region)) errors.push(`${b.id}: unknown region ${b.region}`);
  if (!Number.isFinite(b.year)) errors.push(`${b.id}: bad year`);
  if (!(b.lat >= -90 && b.lat <= 90 && b.lon >= -180 && b.lon <= 180)) errors.push(`${b.id}: bad coordinates`);
  if (!b.concepts.length) errors.push(`${b.id}: no concepts`);
  if (!b.values.length) errors.push(`${b.id}: no values`);
  for (const c of b.concepts) if (!conceptIds.has(c)) errors.push(`${b.id}: unknown concept ${c}`);
  for (const v of b.values) if (!valueIds.has(v)) errors.push(`${b.id}: unknown value ${v}`);
  if (!b.summary) errors.push(`${b.id}: missing summary`);
}

const seen = new Set();
for (const l of data.links) {
  if (!ids.has(l.source)) errors.push(`link: unknown source ${l.source}`);
  if (!ids.has(l.target)) errors.push(`link: unknown target ${l.target}`);
  if (l.source === l.target) errors.push(`link: self-link ${l.source}`);
  if (!linkTypes.has(l.type)) errors.push(`link ${l.source}->${l.target}: bad type ${l.type}`);
  if (!l.note) errors.push(`link ${l.source}->${l.target}: missing note`);
  const key = [l.source, l.target].sort().join("|");
  if (seen.has(key)) errors.push(`link: duplicate pair ${key}`);
  seen.add(key);
  const s = data.books.find((b) => b.id === l.source);
  const t = data.books.find((b) => b.id === l.target);
  if (s && t && l.type !== "kinship" && s.year > t.year) errors.push(`link ${l.source}->${l.target}: ${l.type} goes backwards in time`);
}

for (const j of data.journeys) {
  for (const s of j.steps) if (!ids.has(s)) errors.push(`journey ${j.id}: unknown step ${s}`);
}

for (const c of data.concepts) if (!data.books.some((b) => b.concepts.includes(c.id))) errors.push(`concept unused: ${c.id}`);
for (const v of data.values) if (!data.books.some((b) => b.values.includes(v.id))) errors.push(`value unused: ${v.id}`);
for (const r of data.regions) if (!data.books.some((b) => b.region === r.id)) errors.push(`region unused: ${r.id}`);

if (errors.length) {
  console.error(`✗ ${errors.length} problem(s):\n  ` + errors.join("\n  "));
  process.exit(1);
}
console.log(`✓ ${data.books.length} works, ${data.links.length} links, ${data.concepts.length} concepts, ${data.values.length} values, ${data.journeys.length} journeys — all consistent.`);
