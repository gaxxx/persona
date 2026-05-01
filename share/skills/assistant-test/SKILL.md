---
name: assistant-test
description: Test the personal assistant's routing accuracy and response quality. Run with /assistant-test to execute all cases, /assistant-test add to add new cases, /assistant-test <id> for a single case.
---

# Assistant Test Suite

Test routing accuracy and response quality across all skills.

## Commands

| Command | What it does |
|---------|-------------|
| `/assistant-test` | Run all test cases, report pass/fail + token stats |
| `/assistant-test add` | Add a new test case interactively |
| `/assistant-test <id>` | Run a single test by ID |
| `/assistant-test routing` | Run only routing tests (fast, no actual execution) |
| `/assistant-test quality` | Run full quality tests (slower, checks response content) |
| `/assistant-test stats` | Show token usage summary from last run |

## Test File

Tests live in `<vault>/persona/tests/cases.md` (editable in Obsidian as markdown tables).

Cases are grouped under `## <Section>` headings (e.g. `## Game Time`, `## KB - Immigration`). Each section contains a markdown table with columns: `ID | Input | Skill | Expect Contains | Tags`.

Parse the tables to extract test cases. `Expect Contains` and `Tags` are comma-separated; an empty `Expect Contains` cell means skip the content check.

Example:
```markdown
## Game Time

| ID | Input        | Skill     | Expect Contains | Tags               |
|----|--------------|-----------|-----------------|--------------------|
| 1  | 黑皮工作1小时 | game-time | 黑皮, 工作余额  | routing, game-time |
```

### Fields

| Field | Description |
|-------|-------------|
| `id` | Unique test ID |
| `input` | Simulated Telegram message |
| `expect_skill` | Which skill should handle this: `game-time`, `kb`, `calendar`, `gmail`, `websearch`, `memory`, `task`, `direct` |
| `expect_contains` | Key strings that must appear in the response (empty = skip content check) |
| `tags` | Categories for filtering |

## Running Tests

### Step 1: Load
Read `<vault>/persona/tests/cases.md`. Walk every `##` section; for each, parse the markdown table into rows. Skip rows where the ID column is missing or non-numeric (header / divider rows).

### Step 2: For Each Test

**Routing test** (fast):
1. Read the `input` message
2. Based on CLAUDE.md's skill catalog and available skills, decide which skill would handle it
3. Compare against `expect_skill`
4. Record: PASS if correct, FAIL if wrong skill chosen

**Quality test** (full):
1. Do the routing test above
2. Actually execute the skill (read kb articles, check game-time data, etc.)
3. Generate the response (but do NOT send to Telegram)
4. Check `expect_contains` - all listed strings must appear in the response
5. Record: PASS/FAIL with evidence

**Token tracking:**
- Before each test, note the conversation position
- After each test, estimate tokens used:
  - Input: count characters of all files read × 0.3 (rough char->token ratio)
  - Output: count characters of response × 0.3
- Record in results

### Step 3: Report

```
Assistant Test Results
═════════════════════
Ran 15 tests (10 routing, 5 quality)

Routing:
   1. "黑皮工作1小时" -> game-time - PASS
   2. "查余额" -> game-time - PASS
   3. "我的护照号码是多少" -> kb - PASS
x  5. "明天有什么安排" -> calendar - FAIL (got: direct)
  10. "你好" -> direct - PASS

Quality:
   3. "我的护照号码是多少" -> contains "<passport-number>" - PASS
x 12. "<name> 的 EAD 批了吗" -> missing "批准" - FAIL

Results: 13 passed, 2 failed
Token estimate: ~12K input, ~3K output (15 tests)

Per-skill breakdown:
  game-time: 4 tests, ~2K tokens avg
  kb:        5 tests, ~4K tokens avg
  calendar:  1 test,  ~1K tokens avg
  direct:    2 tests, ~0.5K tokens avg
```

### Step 4: Save Results

Write results to `<vault>/persona/tests/YYYY-MM-DD-HHMMSS.json`:

```json
{
  "timestamp": "2026-04-25T12:30:00-04:00",
  "total": 15,
  "passed": 13,
  "failed": 2,
  "results": [
    {
      "id": 1,
      "input": "黑皮工作1小时",
      "expect_skill": "game-time",
      "actual_skill": "game-time",
      "routing_pass": true,
      "expect_contains": ["黑皮", "工作余额"],
      "response_snippet": "已更新！黑皮工作...",
      "quality_pass": true,
      "est_input_tokens": 2100,
      "est_output_tokens": 350
    }
  ],
  "token_summary": {
    "total_input": 12000,
    "total_output": 3000,
    "by_skill": {
      "game-time": { "tests": 4, "avg_input": 2000, "avg_output": 400 },
      "kb": { "tests": 5, "avg_input": 4000, "avg_output": 600 }
    }
  }
}
```

## Adding Tests

`/test add` flow:

1. Ask: "What message would you test?"
2. Ask: "Which skill should handle it?" (suggest based on message content)
3. Run the message through the assistant (dry run, no Telegram send)
4. Show response, ask: "Are these the key facts to check?"
5. Append a new row to the matching `## <Section>` table in `<vault>/persona/tests/cases.md`. Pick the next free ID (max(existing) + 1). If no section fits, add a new `## <Section>` block with a fresh table.

## Dry Run Mode

All tests run in **dry run mode**:
- Skills are executed but responses are NOT sent to Telegram
- Game-time balances are NOT actually updated
- KB articles are read but no files are modified
- Calendar/Gmail MCP tools are called read-only (list/search, not create/modify)
- Results are captured for verification only

## Comparing Runs

`/test stats` reads the two most recent results files and shows:
- Tests that flipped (pass->fail or fail->pass)
- Token usage changes
- New failures to investigate

## Integration with KB Tests

KB content-accuracy tests are filed in `cases.md` under the `## KB - <topic>` sections (tagged `kb`). This unified test suite covers the full assistant pipeline: routing -> skill execution -> response quality.

- `/assistant-test routing` = "does the assistant pick the right skill?"
- `/assistant-test quality` = "does the response contain the key facts?"
