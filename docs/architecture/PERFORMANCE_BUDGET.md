# PERFORMANCE BUDGET

## 1. Budget

| Item | Budget | Now |
|---|---|---|
| JavaScript shipped | under 100 KB, no dependencies | about 78 KB unminified and uncompressed, zero dependencies |
| CSS | under 25 KB | about 23 KB |
| First paint after sign-in | under 1 s on a mid-range phone | one request (`/v1/status`), start-up sequence only on a new sign-in or first launch on a device |
| Core frame time | under 8 ms on HIGH, 30 fps at rest | fragment shader, one full-screen quad |
| Command round trip | under 1.5 s without a language model | local skills are in-memory |

## 2. Quality tiers

| Tier | Pixel ratio cap | Noise octaves | Particles |
|---|---|---|---|
| HIGH | 1.75 | 5 | yes |
| MEDIUM | 1.25 | 4 | yes |
| LOW | 0.6 | 3 | no |

Every device starts on HIGH, so a phone shows the same Core as a desktop. (A phone at HIGH draws fewer pixels than a desktop at HIGH: 390x844 against 1366x768, both at most 1.75 pixels per point.) The renderer watches its own frame times and steps down a tier only when it truly cannot keep up: an average frame over 45 ms (under about 22 fps) across 90 frames, or over 80 ms across 8. A screen capped at 30 fps, such as an iPhone in Low Power Mode, is not struggling and keeps its tier. A step down lasts for that visit only and is never saved. Tahir can choose a tier in Systems; that choice is saved on the device (`royal.quality.chosen`). The older key `royal.quality`, which saved automatic step-downs and could leave a phone on LOW for good, is cleared on start.

## 3. Saving power

(a) At rest the Core draws at about 30 frames a second.

(b) When the page is hidden it stops drawing entirely.

(c) Reduced motion freezes time in the shader, so the Core is a still image that changes only with state.

## 4. Fallbacks

(a) No WebGL, or the GPU context is lost: the Core is drawn with a 2D canvas (radial light, corona, beams). Systems says "2D fallback".

(b) No canvas at all: the interface works without the Core; states still appear in the top line.
