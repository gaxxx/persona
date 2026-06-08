# assistant-test — output formats

Reference for the report (Step 3) and save (Step 4) steps. Read this when you reach reporting/saving, not during routing/execution.

## Step 3: Report format

```
Assistant Test Results
═════════════════════
Ran 15 tests (10 routing, 5 quality)

Routing:
   1. "<name>工作1小时" -> game-time - PASS
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

## Step 4: Save Results

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
      "input": "<name>工作1小时",
      "expect_skill": "game-time",
      "actual_skill": "game-time",
      "routing_pass": true,
      "expect_contains": ["<name>", "工作余额"],
      "response_snippet": "已更新！<name>工作...",
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
