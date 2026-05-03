---
description: Ground-truth routing test. Spawns a fresh `claude -p` per case to verify which skill the model actually picks. Slow + costs API tokens — use for validating routing changes, not daily iteration.
---

# /test-routing-real

Run `bin/test-routing-real.ts` to ground-truth-test routing decisions against `<vault>/persona/tests/cases.md`.

Each test case spawns a fresh subprocess with a routing-only priming, feeds the input as a `[Telegram event]`, and parses the model's `SKILL=<name>` response. No tools are actually invoked.

## How to run

Full routing suite (slow, ~3-7 min, ~$2):
```bash
bun run bin/test-routing-real.ts
```

Subset by case ID:
```bash
bun run bin/test-routing-real.ts --ids=36,37,38,39,40
```

By tag (default `routing`):
```bash
bun run bin/test-routing-real.ts --tag=gmail-digest
```

Output is per-case PASS/FAIL + a JSON results file under `<vault>/persona/tests/<timestamp>-real.json`.

Report back: pass/fail count, which IDs failed (with actual vs expected), and the JSON path.
