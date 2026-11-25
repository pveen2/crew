---
name: review-verify
description: Ship the current branch the owner's way - commit, open a PR, run the checks, have Codex verify the change independently, fix what it confirms, then merge. Use when the user says "make a PR, verify and merge", "review and verify", "/review-verify", or "check with codex and merge".
---

# Review and verify

Take the work on the current branch to a merged PR. Lead every update with the outcome.

## 1. PR
- If on the default branch, make a branch first.
- Commit everything that belongs to the change (a message that says what changed and why), push, and open a PR against the default branch with `gh pr create`. Body: the problem, the change as short bullets, how it was checked.
- Link the PR with `link_pull_request` (full URL).

## 2. Check
- Run the repo's own checks: typecheck, build, tests if there are any (`package.json` scripts). Fix failures before going on. Note anything you could not run (for example, no data to see the UI with).

## 3. Verify with Codex
- Call `orchestrator_capabilities` (once per thread), then `delegate_task` to a **Codex** model. If Codex is unavailable, say so and stop; do not fall back to another provider unasked.
- Brief it like a peer reviewer, not with your conclusions: the PR URL, the base branch, what the change is meant to do, and the ask: "Review `git diff <base>...HEAD` for correctness bugs, regressions and edge cases. For each finding: file:line, the concrete failure scenario, severity. Do not edit files." Let it read the code itself.
- Wait for its result (follow the task's `next`; no polling).

## 4. Fix
- Check each finding against the code yourself. Fix the real ones, push, and re-run the checks. Say which findings you dismissed and why.
- If the fixes were more than small, run one more Codex verify (a new `delegate_task` with the findings and fixes).

## 5. Merge
- Confirm the PR is mergeable and checks are green (`gh pr view <n> --json mergeable,statusCheckRollup`).
- Merge with `gh pr merge <n> --merge` (this repo uses merge commits) and confirm it shows as merged.
- Mention anything that still needs deploying (for example, conductor/server changes).

## Report
One short answer first: merged or not, the PR link, what Codex found and what was fixed. Details last.
