# Clockwork Timing Playground

An educational, interactive setup/hold timing game with flip-flops, latches, clock skew and time borrowing.

## Play
- [Clockwork V3: Parallel Paths](https://tarak5655.github.io/clockwork-timing-playground/v3/)
- [Clockwork V2: Cell Lab](https://tarak5655.github.io/clockwork-timing-playground/v2/)
- [Clockwork V1](https://tarak5655.github.io/clockwork-timing-playground/)

V3 adds three randomized parallel data routes per stage. Setup uses the largest route maximum; hold uses the smallest route minimum. Each route has independent cell and wire edits, and stage randomization can be undone.

V2 supports double-click expansion of data and clock paths, individual cell size and VT edits, and buffer insertion/removal with live timing feedback.

## Run Offline
Download the repository ZIP and extract it. Open `v3/index.html` in Chrome or another modern browser for V3, `v2/index.html` for V2, or `index.html` for V1. Keep the folder layout intact. No server, installation or account is required; sandbox state is saved locally in your browser.

## Model
Delays are illustrative, not characterized library data or signoff STA. Next-stage capture uses a 180-degree clock. Gates represent sensitized timing arcs, not a Boolean simulator. See the in-app model assumptions and source links.