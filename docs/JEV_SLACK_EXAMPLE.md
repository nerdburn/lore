# Classifying Slack activity with Jev

In Lore, I use TypeSafe's Jev to check incoming Slack activity before sending it to a larger model for extraction. The Slack connector collects messages and tracked thread replies from configured channels. Jev looks at the new text and returns independent probabilities for four questions:

- **Ask:** Is someone requesting work?
- **Decision:** Has someone made or confirmed a project decision?
- **Plan:** Is there a commitment, schedule, or deadline?
- **Progress:** Has work started, shipped, or become blocked?

If pinned facts are provided, it also checks for contradictions. Multiple categories can apply to the same input. The scores describe whether a signal appears anywhere in the supplied material, rather than assigning a label to each message.

For eligible incremental updates, if any probability reaches **0.3**, Lore runs its deeper extraction step (called a “fold”) to produce structured project updates. If all scores are lower, it skips that step. This helps avoid running extraction on casual conversation with no project updates. If the Jev call fails, Lore proceeds with extraction.

## Code example

This example uses Lore's existing [`runGate` implementation](../src/gate.ts). It sends the material and questions to `https://api.typesafe.ai/v1/systemone` using `jev-latest` by default, then collects the classification scores.

Save this as `jev-slack-example.ts` in the Lore repo root. With dependencies installed and `TYPESAFE_API_KEY` set in your environment, run `npx tsx jev-slack-example.ts`. The messages below are fictional sample input; this example does not connect to Slack.

```ts
import { runGate } from './src/gate.js'

const apiKey = process.env.TYPESAFE_API_KEY
if (!apiKey) throw new Error('Set TYPESAFE_API_KEY first')

const result = await runGate(
  {
    material: [{
      path: 'context/streams/slack/#acme-dev/2026-09-25.md',
      text: `
### Priya — 09:00
Can we add Apple Pay to checkout before launch?

### Sam — 09:02
Approved. Let's include Apple Pay in the launch scope.

### Alex — 09:05
I'll finish the integration by Tuesday.

### Alex — 14:30
The integration is in progress, but testing is blocked
until we get the payment sandbox credentials.
      `.trim(),
    }],
    trackedWork: 'ACM-18 | in_progress | Add Apple Pay to checkout',
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
    "ask": 0.98,
    "decision": 0.96,
    "plan": 0.97,
    "progress": 0.99
  },
  "top": {
    "question": "progress",
    "p": 0.99
  },
  "chunks": 1,
  "inputTokens": 480
}
```

Priya's request signals an ask, Sam's approval signals a decision, Alex's Tuesday commitment signals a plan, and the testing blocker signals progress. At least one score exceeds the threshold, so `fold: true` tells Lore to continue with extraction. The larger model then writes the actual artifacts.

`max` contains the highest score for each question across input chunks; this short example fits in one chunk. `top` identifies the strongest signal, and `inputTokens` reports the Jev input token usage.
