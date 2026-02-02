# Provenance, Ledger, and Badge Schemas

## ContributionRecord (provenance/*.json)
- `record_id` (string, uuid)
- `actor_id` (string)
- `actor_pubkey` (string) - public key used to sign
- `project_id` (string)
- `task_id` (string)
- `action` (string) - submit|validate|merge|claim
- `result_cid` (string) - ipfs://CID
- `validator_score` (number) - 0.0..1.0
- `credits_awarded` (integer)
- `timestamp` (ISO 8601)
- `signature` (string) - base64 or hex signature of canonical JSON

## Ledger (ledger/ledger.json)
Top-level object keyed by actor_id:
```json
{
  "actor-uuid": {
    "credits": 100,
    "staked": 10,
    "reputation": 0.8,
    "last_updated": 1670000000,
    "history": [
      {"time": 1670000000, "change": 10, "reason": "onboarding"}
    ]
  }
}
```

## Badge (badges/*.json)
- `badge_id` (string)
- `actor_id` (string)
- `title` (string)
- `issued_at` (ISO 8601)
- `evidence_cid` (string) - ipfs://CID pointing to evidence
- `signature` (string) - maintainer or curator signature

## Signing rules
- Agents sign ContributionRecord JSON using their agent key.
- Maintainers sign ledger snapshots and curator signoffs using GPG.
- Canonical signing: sort JSON keys lexicographically, serialize without whitespace, sign the bytes.

## Merkle anchoring
- Build Merkle tree over SHA256(provenance file bytes) leaves.
- Commit merkle_roots/YYYY-MM-DD.json with { root, count, files, mapping }.
- Anchor root on-chain (Solana memo or small program) for tamper evidence.
