# ROYAL: SPATIAL DESIGN SYSTEM

Tokens live in `web/css/royal.css`. The Core's colours live in the shader in `web/js/core.js`.

## 1. The Core

A controlled artificial sun: a near-white centre, a lime body of slow plasma, a bright limb, a corona with filaments, faint arcs, one tilted orbital ring and sparse particles. It is original work, drawn in a fragment shader; no film or comic asset is used or imitated. It is never decoration: every change in it means a change of state.

## 2. Colour

| Token | Value | Use |
|---|---|---|
| void | #050605 | Space. Everything sits on it. |
| ink, ink-2, ink-3 | #e9ede2, #b4baa9, #7c8274 | Text, secondary, quiet labels |
| lime | #95fe00 | Energy only: the Core, focus rings, the one action that commits (Approve, Send) |
| amber | #ffb54a | Attention: waiting decisions, warnings, unknowns |
| red | #ff5a48 | Serious risk and failure, sparingly |

Lime is never used for ordinary text or borders. Amber and red never appear without meaning.

## 3. Type

Lora carries ROYAL's voice (captions, titles, drafts). Poppins carries labels and controls. A monospace face appears only in the start-up sequence and Systems. Captions scale with the viewport; long sentences step down a size.

## 4. Space

(a) **Rest.** The Core centred slightly above the middle; the caption beneath it; nothing else but three marks at the corners (identity and state; menu; spoken replies and keyboard).

(b) **Content on a phone or tablet in portrait.** The Core rises to the top and shrinks. The column of objects scrolls beneath it with soft edges.

(c) **Content on a wide screen.** The Core moves to the left third and stays large; the column sits to the right.

(d) **Agent nodes** sit on an arc above the Core (rest, wide) or either side of it (risen). Each is a point of light, its name and its state.

## 5. Objects

Dark glass panels, 16px radius, a hairline border, a 2px risk bar on the left edge for amber or red items. They materialize in order (70ms apart: fade, rise, un-blur) and recede when replaced (240ms). Decisions carry an amber hairline and a soft amber glow while open.

## 6. Motion

Ease-out curves, nothing bouncy. The Core's layout eases over about half a second. Reduced motion removes breathing, particles, stagger and blur; states still change.

## 7. Touch

Every control is at least 44px. The Core's touch target is larger than the Core itself. There is no hover-only behaviour.
