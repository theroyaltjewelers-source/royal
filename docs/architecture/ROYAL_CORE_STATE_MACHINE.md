# ROYAL: CORE STATE MACHINE

The Core shows exactly one state at a time, and the state is always the one the system is in. The table in `web/js/state.js` gives each state fixed visual parameters; the renderer eases toward them. The same state always looks the same.

## 1. States

| State | When | How it looks |
|---|---|---|
| OFFLINE | Before sign-in, or ROYAL cannot be reached | Dim, small, nearly still |
| AMBIENT | Signed in, nothing happening | Slow breathing, soft corona |
| AWAKE | Touched, greeted, ready | Brighter, a little larger |
| LISTENING | Speech input is open | Responds to microphone level |
| UNDERSTANDING | Words received, request leaving | Contracts; particles drawn inward |
| THINKING | Request in flight | Faster, less ordered plasma |
| RETRIEVING | Reserved for streamed retrieval | Energy reaching outward |
| DELEGATING | Specialists took part in this answer | Beams to each specialist node |
| ACTING | A decision is being resolved | Full energy, beams |
| WAITING_FOR_APPROVAL | An open decision is on screen | Very still, a trace of amber |
| RESPONDING | ROYAL is answering | Steady; speech pulses the Core |
| COMPLETE | Done | Brief bright contraction, then AWAKE |
| WARNING | The answer is serious | Amber |
| FAILURE | Something could not be done | Dim with restrained red |

## 2. Transitions

`RoyalState.go(next)` refuses any transition not in `TRANSITIONS` and logs it, so a bug cannot put a false state on screen. From AMBIENT only waking, listening, understanding, going offline, a warning or an approval wait are legal; every active state may go to any other.

## 3. Rules

(a) DELEGATING is entered only when the presentation carries agents, which the server builds only from real delegations.

(b) WAITING_FOR_APPROVAL holds until the decision is resolved. Idle time does not clear it.

(c) COMPLETE lasts about 1.6 seconds, then AWAKE; forty seconds of quiet returns to AMBIENT.

(d) The text label in the top line and a screen-reader live region always name the current state, so the state never depends on seeing the light.

(e) Reduced motion freezes breathing and particles; state changes remain, as changes of brightness, size and colour.
