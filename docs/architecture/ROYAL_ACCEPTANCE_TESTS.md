# ROYAL ACCEPTANCE TESTS

*What is automated, what was checked by hand, and what needs Tahir's phone or a live key.*

## 1. Automated (`npm test`)

(a) **First person:** 13 questions with and without a calculator and provider, both realms (`tests/correction.test.js`).

(b) **Identity:** built from live connections; every prompt and the voice session start with it.

(c) **Speed by construction:** greeting, identity, thanks and definitions make no model call; an unplaced question makes one, at low effort, with its cached tokens measured; reasoning effort per level; the cache key on every call; a rejected setting dropped once.

(d) **House language:** definitions from House sources; a balance is state, not a definition.

(e) **Voice:** sentence streaming in order, pieces back to back, the first sentence alone, fallback, barge-in before and during the sound, mute, underruns counted (`tests/voice.test.js`).

(f) **Grok Bots:** unverified until a real round trip, then verified, then degraded or failed when delivery fails, with no address or key exposed (`tests/grokbot.test.js`).

## 2. Checked by hand here

Benchmark before and after against a simulated xAI (`ROYAL_PERFORMANCE_AUDIT.md`); sentence streaming in Chromium at phone and desktop sizes, 0 gaps.

## 3. Needs the live system

(a) **Latency:** `npm run bench` against the real server; p50 and p95 per category.

(b) **10-minute voice session** on the phone: no repeated gaps, no overlap, no old audio after an interruption, no voice reset, interruptions work. Record the Systems line (first sound, gaps) before and after.

(c) **Mixed conversation:** "Hey ROYAL", "Who are you?", "What does Marcus owe?", "Why hasn't his project moved?", "Who is Nike's current CFO?", "Get me their business email", "Do you think they're a good prospect?", "Have ACE put together an approach", "While ACE does that, what needs me today?", then "Stop. Just tell me the most important one."

(d) **Each Grok Bot:** "Check connection" in Bots; each must reach "Connected, verified".

(e) **House language:** ask the four definition questions, then "What stage is Marcus in?" and confirm one is a definition and the other live data.
