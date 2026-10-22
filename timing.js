(function (root) {
  'use strict';

  const VT = { HVT: 1.24, SVT: 1.12, LVT: 1, ULVT: 0.82 };
  const clone = value => JSON.parse(JSON.stringify(value));
  const path = (logicMax, logicMin, wire) => ({ logicMax, logicMin, wire, buffers: 0, size: 1, vt: 'LVT' });

  function defaults() {
    return {
      period: 1000, launchSkew: 0, setup: 60, hold: 40,
      cqMax: 60, cqMin: 30, dqMax: 35, dqMin: 18,
      setupUncertainty: 20, holdUncertainty: 10,
      jitter: 0, holdJitter: 0, noise: 0, lateDerate: 0, earlyDerate: 0,
      borrowing: true, borrowLimit: 500,
      branches: [
        { id: 'A', kind: 'ff', skew: 0, nextSkew: 0, input: path(470, 150, 130), output: path(180, 70, 55) },
        { id: 'B', kind: 'latch', skew: 0, nextSkew: 0, input: path(550, 180, 120), output: path(200, 75, 65) },
        { id: 'C', kind: 'ff', skew: 0, nextSkew: 0, input: path(760, 190, 140), output: path(220, 90, 65) }
      ]
    };
  }

  function delay(arc, state) {
    const scale = VT[arc.vt] / Math.sqrt(arc.size);
    const cellMax = arc.logicMax * scale;
    const cellMin = arc.logicMin * scale;
    const bufferMax = arc.buffers * 40;
    const bufferMin = arc.buffers * 24;
    const rawMax = cellMax + arc.wire + bufferMax;
    const rawMin = cellMin + arc.wire * 0.55 + bufferMin;
    return {
      max: rawMax * (1 + state.lateDerate / 100) + state.noise,
      min: Math.max(0, rawMin * (1 - state.earlyDerate / 100) - state.noise),
      cellMax, cellMin, bufferMax, bufferMin, wireMax: arc.wire, wireMin: arc.wire * 0.55,
      noise: state.noise, rawMax, rawMin
    };
  }

  function analyze(state) {
    const setupMargin = state.setupUncertainty + state.jitter;
    const holdMargin = state.holdUncertainty + state.holdJitter;
    const fanoutMax = 6 * (state.branches.length - 1);
    const fanoutMin = 3 * (state.branches.length - 1);
    const launchMax = state.launchSkew + state.cqMax + fanoutMax;
    const launchMin = state.launchSkew + state.cqMin + fanoutMin;
    const branches = state.branches.map(branch => {
      const input = delay(branch.input, state);
      const output = delay(branch.output, state);
      const arrivalMax = launchMax + input.max;
      const arrivalMin = launchMin + input.min;
      const close = state.period + branch.skew;
      const open = state.period / 2 + branch.skew;
      const latch = branch.kind === 'latch';
      const physicalRequired = close - state.setup - setupMargin;
      const allowedBorrow = latch ? Math.max(0, Math.min(state.borrowing ? state.borrowLimit : 0, physicalRequired - open)) : 0;
      const required = latch ? Math.min(physicalRequired, open + allowedBorrow) : physicalRequired;
      const holdRequired = branch.skew + state.hold + holdMargin;
      const setupSlack = required - arrivalMax;
      const holdSlack = arrivalMin - holdRequired;
      const borrowed = latch ? Math.max(0, arrivalMax - open) : 0;
      const qMax = latch ? Math.max(open, arrivalMax) + state.dqMax : close + state.cqMax;
      const qMin = latch ? Math.max(open, arrivalMin) + state.dqMin : close + state.cqMin;
      const nextEdge = 1.5 * state.period + branch.nextSkew;
      const nextHoldEdge = 0.5 * state.period + branch.nextSkew;
      const nextArrivalMax = qMax + output.max;
      const nextArrivalMin = qMin + output.min;
      const nextRequired = nextEdge - state.setup - setupMargin;
      const nextHoldRequired = nextHoldEdge + state.hold + holdMargin;
      const stage1Valid = setupSlack >= -1e-8 && holdSlack >= -1e-8;
      const second = {
        arrivalMax: nextArrivalMax, arrivalMin: nextArrivalMin,
        required: nextRequired, holdRequired: nextHoldRequired,
        setupSlack: nextRequired - nextArrivalMax, holdSlack: nextArrivalMin - nextHoldRequired,
        edge: nextEdge, holdEdge: nextHoldEdge, provisional: !stage1Valid
      };
      return {
        id: branch.id, kind: branch.kind, input, output,
        first: { arrivalMax, arrivalMin, required, physicalRequired, holdRequired, setupSlack, holdSlack,
          edge: close, holdEdge: branch.skew, open, close, borrowed, allowedBorrow, valid: stage1Valid },
        second, qMax, qMin,
        valid: stage1Valid && second.setupSlack >= -1e-8 && second.holdSlack >= -1e-8
      };
    });
    const checks = branches.flatMap(branch => [branch.first.setupSlack, branch.first.holdSlack, branch.second.setupSlack, branch.second.holdSlack]);
    return { branches, setupMargin, holdMargin, launchMax, launchMin, fanoutMax, fanoutMin,
      worstSetup: Math.min(...branches.flatMap(branch => [branch.first.setupSlack, branch.second.setupSlack])),
      worstHold: Math.min(...branches.flatMap(branch => [branch.first.holdSlack, branch.second.holdSlack])),
      violations: checks.filter(slack => slack < -1e-8).length,
      valid: branches.every(branch => branch.valid) };
  }

  function challenge(index) {
    const state = defaults();
    state.branches = state.branches.slice(0, 2);
    state.branches.forEach(branch => { branch.kind = 'ff'; });
    if (index === 1) state.branches[0].input = path(930, 190, 130);
    if (index === 2) {
      state.branches[0].input = path(80, 12, 10);
      state.branches[0].skew = 100;
    }
    if (index === 3) {
      state.branches[0].input = path(740, 150, 150);
      state.branches[0].output = path(350, 90, 65);
    }
    if (index === 4) {
      state.borrowing = false;
      state.branches[0].kind = 'latch';
      state.branches[0].input = path(570, 160, 120);
      state.branches[0].output = path(470, 100, 65);
    }
    if (index === 5) {
      state.noise = 45; state.jitter = 35;
      state.lateDerate = 10; state.earlyDerate = 10;
      state.branches[0].input = path(720, 80, 110);
      state.branches[1].input = path(120, 18, 20);
      state.branches[1].skew = 40;
    }
    return state;
  }

  const api = { defaults, clone, delay, analyze, challenge, VT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Timing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);