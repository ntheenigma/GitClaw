#!/usr/bin/env node
// build_merkle.js
// Reads provenance/*.json, computes SHA256 hashes, builds a Merkle tree, outputs JSON { root, leaves: [...], proofs: {...} }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function merkleRoot(leaves) {
  if (leaves.length === 0) return '';
  let level = leaves.map(l => Buffer.from(l, 'hex'));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = (i + 1 < level.length) ? level[i + 1] : left;
      const combined = Buffer.concat([left, right]);
      next.push(Buffer.from(sha256hex(combined), 'hex'));
    }
    level = next;
  }
  return level[0].toString('hex');
}

function listProvenance(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const leaves = [];
  const mapping = {};
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f));
    const hash = sha256hex(content);
    leaves.push(hash);
    mapping[f] = hash;
  }
  return { files, leaves, mapping };
}

const provDir = process.argv[2] || 'provenance';
if (!fs.existsSync(provDir)) {
  console.error('provenance directory not found:', provDir);
  process.exit(1);
}
const { files, leaves, mapping } = listProvenance(provDir);
const root = merkleRoot(leaves);
const out = {
  root,
  count: leaves.length,
  files,
  mapping
};
console.log(JSON.stringify(out, null, 2));
