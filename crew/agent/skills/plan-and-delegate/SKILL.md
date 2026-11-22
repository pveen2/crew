---
name: plan-and-delegate
description: Break a multi-part request into briefs for specialists. Use when a request needs more than one specialist or more than one step.
---

# Plan and delegate

1. Write the plan as a short list: step, which specialist, what they return,
   and which steps depend on others.
2. Call each specialist through its own tool. Independent steps may run in
   parallel; a step that needs another's result waits for it and gets the
   earlier artifact id in its brief.
3. A good brief has five parts:
   - **Goal**: one sentence on what the owner wants to achieve.
   - **Context**: facts the specialist needs (they cannot see the thread),
     including artifact ids of earlier steps and the owner's relevant
     preferences.
   - **Constraints**: read only or change allowed, budget, deadline, tone,
     market.
   - **Return**: the exact shape of the answer (table, three options, a
     draft, yes/no with evidence), and whether to save it as an artifact.
   - **Done when**: how you will judge it.
4. When results come back, hand the work back as it is: show artifacts with
   `show_preview(artifactId)`. Write only what connects the pieces: the
   outcome, open questions and who did what.
