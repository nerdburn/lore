# Classifying GitHub activity with Jev

In Lore, I use TypeSafe's Jev to check incoming GitHub activity before sending it to a larger model for extraction. The GitHub connector collects issues, pull requests, comments, reviews, commits, and releases. Jev looks at the new text and returns independent probabilities for four questions:

- **Ask:** Is someone requesting work?
- **Decision:** Has someone made or confirmed a project decision?
- **Plan:** Is there a commitment, schedule, or deadline?
- **Progress:** Has work started, merged, shipped, or become blocked?

If pinned facts are provided, it also checks for contradictions. Multiple categories can apply to the same input.

For eligible incremental updates, if any probability reaches **0.3**, Lore runs its deeper extraction step (called a “fold”) to produce structured project updates. If all scores are lower, it skips that step. If the Jev call fails, Lore proceeds with extraction. Jev decides whether to process the input; the larger model writes the artifacts.

## Code example

This example uses Lore's existing [`runGate` implementation](../src/gate.ts). It sends the material and questions to `https://api.typesafe.ai/v1/systemone` using `jev-latest` by default, then collects the classification scores.

Save this as `jev-example.ts` in the Lore repo root. With dependencies installed and `TYPESAFE_API_KEY` set in your environment, run `npx tsx jev-example.ts`.

```ts
import { runGate } from './src/gate.js'

const apiKey = process.env.TYPESAFE_API_KEY
if (!apiKey) throw new Error('Set TYPESAFE_API_KEY first')

const result = await runGate(
  {
    material: [{
      path: 'context/streams/github/acme_web/2026-09-25.md',
      text: `
PR #142: Add webhook retries
Review: Approved. Let's use exponential backoff.
Comment: I'll deploy this Friday.
Update: PR merged into main.
      `.trim(),
    }],
    trackedWork: 'ACM-12 | in_progress | Add webhook retries',
    pins: '',
  },
  { apiKey },
)

console.log(JSON.stringify(result, null, 2))
```

## Example output

This is **illustrative output from Lore's wrapper**, not a recorded Jev response. The probabilities and token count are made up to demonstrate the format.

```json
{
  "fold": true,
  "max": {
    "ask": 0.12,
    "decision": 0.96,
    "plan": 0.94,
    "progress": 0.99
  },
  "top": {
    "question": "progress",
    "p": 0.99
  },
  "chunks": 1,
  "inputTokens": 420
}
```

“Approved” signals a decision, “I'll deploy this Friday” signals a plan, and “PR merged” signals progress. At least one score exceeds the threshold, so `fold: true` tells Lore to continue with extraction.

`max` contains the highest score for each question across input chunks; this short example fits in one chunk. `top` identifies the strongest signal, and `inputTokens` reports the Jev input token usage.
