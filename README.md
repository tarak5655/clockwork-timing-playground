# Clockwork Timing Playground

An educational, interactive setup/hold timing game with flip-flops, latches, clock skew and time borrowing.

## Play
- [Clockwork V4: Clock Edges and Timing Arithmetic](https://tarak5655.github.io/clockwork-timing-playground/v4/)
- [Clockwork V3: Parallel Paths](https://tarak5655.github.io/clockwork-timing-playground/v3/)
- [Clockwork V2: Cell Lab](https://tarak5655.github.io/clockwork-timing-playground/v2/)
- [Clockwork V1](https://tarak5655.github.io/clockwork-timing-playground/)

V4 separates clock latency from setup and hold capture edges. Sandbox next-stage FFs default to the same clock phase, with a per-branch 180-degree option. Low-level latches are transparent from T/2 to T. Detailed arrival and required-time tables show each clock buffer, data cell, wire delay, variation adjustment, margin, and latch wait. V4 retains three parallel routes per stage.

V3 adds three randomized parallel data routes per stage. Setup uses the largest route maximum; hold uses the smallest route minimum. Each route has independent cell and wire edits, and stage randomization can be undone.

V2 supports double-click expansion of data and clock paths, individual cell size and VT edits, and buffer insertion/removal with live timing feedback.

## Run Offline
Download the repository ZIP and extract it. Open `v4/index.html` in Chrome or another modern browser for V4, `v3/index.html` for V3, `v2/index.html` for V2, or `index.html` for V1. Keep the folder layout intact. No server, installation or account is required; sandbox state is saved locally in your browser.

## Model
Delays are illustrative, not characterized library data or signoff STA. V1-V3 use 180-degree next-stage capture. V4 sandbox defaults to same-phase capture; its fixed challenges retain 180 degrees. Latch transfer uses the educational max(opening, data arrival) + transfer-delay approximation. Gates represent sensitized timing arcs, not a Boolean simulator. See the in-app model assumptions and source links.