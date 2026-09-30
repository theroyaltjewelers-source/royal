# VOICE: FUTURE

*Voice input and output are now built in the web client. See VOICE_ARCHITECTURE.md; the rules below still hold.*

(a) Voice is a modality, not a second intelligence. A spoken command enters as `CommandInput {modality: "voice", content: <transcript>, context, user, timestamp}` and goes through the same `royal.handle()`, router, gate and audit as text.

(b) What voice adds: a speech-to-text front end, a spoken rendering of `summary` (every surface already leads with a one-sentence summary written to be read aloud), and a stricter confirmation rule. **A spoken "yes" never approves a Decision.** Approval stays a deliberate action on a card, because a misheard word cannot be undone.

(c) Ambiguity matters more in speech. The clarification surface (two Johnsons) becomes a spoken choice, and ROYAL never acts on a guessed entity.

(d) Behind `voice_input`, off. Nothing in the V1 architecture needs to change to add it.
