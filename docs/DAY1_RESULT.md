# Day 1 result — gateway lifecycle

## Live bridge observation — 2026-09-07

| Measure | Observed |
| --- | ---: |
| Balance before attempted inference | $100.076010 |
| Gateway spend before/after attempted inference | $0.000000 / $0.000000 |
| Confirmed paid inference | **No** |
| Gateway key after revoke | **Absent** |
| Balance after revoke | $100.076010 |

The `@openrouter/agent` high-level path targets `/responses`, which the Orbio gateway returned as unsupported. Its typed Chat Completions transport did not complete within the local safety window and was terminated before a result could be received. A fresh balance read showed no charge, then `orbio_revoke_key` succeeded. `orbio_get_key_status` confirmed no key, and the balance was unchanged.

This proves **revoke → key dead → balance intact**, but it does **not** prove a live paid spend. Do not call this a full end-to-end paid lifecycle proof.

## Mock gateway run

```text
D1 MODE: mock
1 BALANCE_BEFORE_SPEND: $50.000000
2 KEY_CREATED: key_id=mock-gateway-0001
3 INFERENCE_CALL: model=openai/gpt-4.1-mini cost=$0.000020 cap=$1.000000
4 BALANCE_AFTER_SPEND: $49.999980 delta=$0.000020
5 KEY_REVOKED: has_key=false
6 BALANCE_AFTER_REVOKE: $49.999980

=== D1 GATEWAY LIFECYCLE SUMMARY ===
balance_before_spend: $50.000000
spent: $0.000020
balance_after_spend: $49.999980
key_revoked: true
balance_after_revoke: $49.999980
balance_intact_after_revoke: true
```

## Frozen contract

`contracts/feed.schema.json` now models the gateway, not legacy funded keys. It has no `key_unused`, `BALANCE_RETURNED`, `KEY_DELETED`, or return-latency field. The defined events are balance reads, gateway-key creation/status/revocation, inference, and reconciliation failure. Every event retains the verbatim provider response in `raw`.
