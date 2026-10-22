(function (root) {
  'use strict';
  const base = typeof module !== 'undefined' && module.exports ? require('../timing.js') : root.Timing;
  const LIBRARY = {
    BUF: { min: 24, max: 40, clock: 32 },
    AND: { min: 30, max: 60 },
    OR: { min: 32, max: 64 },
    NAND: { min: 20, max: 42 },
    NOR: { min: 24, max: 48 },
    NOT: { min: 12, max: 25 }
  };
  const SIZES = [0.5, 1, 1.5, 2, 3, 4];
  const MAX_CELLS = 32;

  function cell(type = 'BUF') {
    if (!Object.hasOwn(LIBRARY, type)) throw new Error('Unsupported cell type');
    return { type, size: 1, vt: 'LVT' };
  }

  function cellDelay(instance) {
    const reference = LIBRARY[instance.type];
    const scale = base.VT[instance.vt] / Math.sqrt(instance.size);
    return { min: reference.min * scale, max: reference.max * scale,
      nominal: (reference.clock || (reference.min + reference.max) / 2) * scale };
  }

  function chainDelay(cells) {
    return cells.reduce((total, instance) => {
      const value = cellDelay(instance);
      return { min: total.min + value.min, max: total.max + value.max, nominal: total.nominal + value.nominal };
    }, { min: 0, max: 0, nominal: 0 });
  }

  function seedPath(arc) {
    const pattern = ['NAND', 'AND', 'NOR', 'OR', 'NOT', 'BUF'];
    const count = Math.max(1, Math.round(arc.logicMax / 48));
    return { ...arc, buffers: 0, size: 1, vt: 'LVT', cells: Array.from({ length: count }, (_, index) => cell(pattern[index % pattern.length])) };
  }

  function clockPath() { return { wire: 0, cells: [cell('BUF')] }; }

  function defaults() {
    const state = base.defaults();
    state.version = 2;
    state.clockPaths = { L: clockPath() };
    state.branches.forEach(branch => {
      branch.input = seedPath(branch.input);
      branch.output = seedPath(branch.output);
      state.clockPaths[`${branch.id}1`] = clockPath();
      state.clockPaths[`${branch.id}2`] = clockPath();
    });
    return state;
  }

  function clockDelay(path, offset = 0) {
    return offset + path.wire + chainDelay(path.cells).nominal;
  }

  function project(state) {
    const result = base.clone(state);
    result.launchSkew = clockDelay(state.clockPaths.L, state.launchSkew);
    result.branches.forEach(branch => {
      branch.skew = clockDelay(state.clockPaths[`${branch.id}1`], branch.skew);
      branch.nextSkew = clockDelay(state.clockPaths[`${branch.id}2`], branch.nextSkew);
      for (const key of ['input', 'output']) {
        const total = chainDelay(branch[key].cells);
        Object.assign(branch[key], { logicMin: total.min, logicMax: total.max, buffers: 0, size: 1, vt: 'LVT' });
      }
    });
    return result;
  }

  function analyze(state) {
    const effective = project(state);
    return { ...base.analyze(effective), effective };
  }

  function resizeFanout(state, count) {
    if (![2, 3, 4].includes(count)) throw new Error('Fanout must be 2, 3, or 4');
    while (state.branches.length < count) {
      const branch = base.clone(defaults().branches[0]);
      branch.id = 'ABCD'[state.branches.length];
      state.branches.push(branch);
      state.clockPaths[`${branch.id}1`] = clockPath();
      state.clockPaths[`${branch.id}2`] = clockPath();
    }
    for (const removed of state.branches.slice(count)) {
      delete state.clockPaths[`${removed.id}1`]; delete state.clockPaths[`${removed.id}2`];
    }
    state.branches = state.branches.slice(0, count);
  }

  function challenge(index) {
    const state = defaults();
    resizeFanout(state, 2);
    state.branches.forEach(branch => { branch.kind = 'ff'; });
    const first = state.branches[0];
    if (index === 1) first.input.cells = Array.from({ length: 15 }, () => cell('AND'));
    if (index === 2) {
      first.input.cells = [cell('NOT')]; first.input.wire = 10; first.skew = 100;
      first.output.wire = 40;
    }
    if (index === 3) {
      first.input.cells = Array.from({ length: 12 }, () => cell('AND')); first.input.wire = 150;
      first.output.cells = Array.from({ length: 6 }, () => cell('AND')); first.output.wire = 65;
    }
    if (index === 4) {
      state.borrowing = false; first.kind = 'latch';
      first.input.cells = Array.from({ length: 9 }, () => cell('AND')); first.input.wire = 120;
      first.output.cells = Array.from({ length: 7 }, () => cell('AND')); first.output.wire = 65;
    }
    if (index === 5) {
      state.noise = 45; state.jitter = 35; state.lateDerate = 10; state.earlyDerate = 10;
      first.input.cells = Array.from({ length: 12 }, () => cell('AND')); first.input.wire = 110;
      state.branches[1].input.cells = [cell('NOT')]; state.branches[1].input.wire = 20; state.branches[1].skew = 40;
    }
    return state;
  }

  function validState(state) {
    if (!state || state.version !== 2 || !state.clockPaths || !Array.isArray(state.branches) || ![2, 3, 4].includes(state.branches.length)) return false;
    const limits = { period: [600, 2400], launchSkew: [-120, 120], setup: [0, 150], hold: [0, 120], cqMax: [0, 200], cqMin: [0, 200], dqMax: [0, 150], dqMin: [0, 150], setupUncertainty: [0, 150], holdUncertainty: [0, 150], jitter: [0, 150], holdJitter: [0, 100], noise: [0, 150], lateDerate: [0, 30], earlyDerate: [0, 30], borrowLimit: [0, 1200] };
    for (const [key, [minimum, maximum]] of Object.entries(limits)) {
      if (!Number.isFinite(state[key]) || state[key] < minimum || state[key] > maximum) return false;
    }
    if (typeof state.borrowing !== 'boolean' || state.cqMin > state.cqMax || state.dqMin > state.dqMax) return false;
    const validPath = (path, clock = false) => path && Number.isFinite(path.wire) && path.wire >= 0 && path.wire <= 600 &&
      Array.isArray(path.cells) && path.cells.length <= MAX_CELLS && path.cells.every(instance => instance &&
        Object.hasOwn(LIBRARY, instance.type) && (!clock || instance.type === 'BUF') && SIZES.includes(instance.size) && Object.hasOwn(base.VT, instance.vt));
    if (!validPath(state.clockPaths.L, true)) return false;
    return state.branches.every((branch, index) => branch && branch.id === 'ABCD'[index] && ['ff', 'latch'].includes(branch.kind) &&
      [branch.skew, branch.nextSkew].every(value => Number.isFinite(value) && value >= -200 && value <= 200) &&
      validPath(branch.input) && validPath(branch.output) && validPath(state.clockPaths[`${branch.id}1`], true) && validPath(state.clockPaths[`${branch.id}2`], true));
  }

  const api = { ...base, LIBRARY, SIZES, MAX_CELLS, cell, cellDelay, chainDelay, clockDelay, defaults, project, analyze, resizeFanout, challenge, validState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Timing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);