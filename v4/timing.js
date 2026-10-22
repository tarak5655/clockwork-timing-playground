(function (root) {
  'use strict';
  const commonJS = typeof module !== 'undefined' && module.exports;
  const previous = commonJS ? require('../v3/timing.js') : root.Timing;
  const sum = rows => rows.reduce((total, row) => total + row.value, 0);
  const term = (component, expression, value) => ({ component, expression, value });

  function defaults(seed) {
    const state = previous.defaults(seed);
    state.version = 4;
    state.branches.forEach(branch => { branch.nextPhase = 0; });
    return state;
  }

  function clockTerms(state, id, base, edgeLabel) {
    const branch = state.branches.find(item => item.id === id[0]);
    const offset = id === 'L' ? state.launchSkew : branch[id.endsWith('1') ? 'skew' : 'nextSkew'];
    const path = state.clockPaths[id];
    return [term(`${id} ${edgeLabel}`, 'Nominal cycle / phase reference', base),
      term(`${id} signed clock offset`, 'User offset', offset),
      ...path.cells.map((cell, index) => term(`${id} clock U${index + 1} / BUF`, `32 * ${previous.VT[cell.vt]} / sqrt(${cell.size}) [${cell.vt}]`, previous.cellDelay(cell).nominal)),
      term(`${id} clock wire`, 'Nominal wire delay', path.wire)];
  }

  function routeTerms(route, state, maximum, prefix) {
    const kind = maximum ? 'max' : 'min';
    const rows = route.cells.map((cell, index) => term(`${prefix} U${index + 1} / ${cell.type}`, `${previous.LIBRARY[cell.type][kind]} * ${previous.VT[cell.vt]} / sqrt(${cell.size}) [${cell.vt}, ${kind}]`, previous.cellDelay(cell)[kind]));
    rows.push(term(`${prefix} data wire`, maximum ? 'Maximum wire delay' : `${route.wire} * 0.55`, route.wire * (maximum ? 1 : 0.55)));
    const raw = sum(rows);
    rows.push(term(`${prefix} ${maximum ? 'late' : 'early'} OCV adjustment`, `${raw} * ${maximum ? state.lateDerate : -state.earlyDerate} / 100`, raw * (maximum ? state.lateDerate : -state.earlyDerate) / 100));
    rows.push(term(`${prefix} noise adjustment`, maximum ? '+ noise bound' : '- noise bound', maximum ? state.noise : -state.noise));
    if (!maximum && sum(rows) < 0) rows.push(term(`${prefix} minimum clamp`, 'max(0, delay): correction to zero', -sum(rows)));
    return rows;
  }

  function trace(rows) {
    let running = 0;
    return { rows: rows.map(row => ({ ...row, total: running += row.value })), total: running };
  }

  function breakdown(state, branch, view, result, output, maximum) {
    const current = output ? view.second : view.first;
    const arc = view[output ? 'output' : 'input'];
    const routeId = maximum ? arc.setupRoute : arc.holdRoute;
    const suffix = maximum ? 'Max' : 'Min';
    let arrival;
    let opening = null;
    if (!output) {
      arrival = [...clockTerms(state, 'L', 0, 'launch edge'),
        term('Launch FF clock-to-Q', `CQ ${maximum ? 'max' : 'min'}`, state[`cq${suffix}`]),
        term('Launch fanout', `${state.branches.length - 1} extra branches * ${maximum ? 6 : 3}`, result[`fanout${suffix}`])];
    } else if (branch.kind === 'ff') {
      arrival = [...clockTerms(state, `${branch.id}1`, state.period, 'launch edge'),
        term(`${branch.id}1 FF clock-to-Q`, `CQ ${maximum ? 'max' : 'min'}`, state[`cq${suffix}`])];
    } else {
      arrival = view.first.breakdown[maximum ? 'setup' : 'hold'].arrival.rows.map(({ component, expression, value }) => term(component, expression, value));
      opening = trace(clockTerms(state, `${branch.id}1`, state.period / 2, 'latch opening edge'));
      const inputArrival = view.first[`arrival${suffix}`];
      arrival.push(term('Wait for latch opening', `max(${view.first.open}, ${inputArrival}) - ${inputArrival}`, Math.max(0, view.first.open - inputArrival)));
      arrival.push(term('Latch transfer', `DQ ${maximum ? 'max' : 'min'}; max(open, input arrival) + DQ`, state[`dq${suffix}`]));
    }
    arrival.push(...routeTerms(branch[output ? 'output' : 'input'].routes[routeId - 1], state, maximum, `${branch.id}${output ? 2 : 1} P${routeId}`));
    const base = output ? current[maximum ? 'baseEdge' : 'baseHoldEdge'] : maximum ? state.period : 0;
    const required = clockTerms(state, `${branch.id}${output ? 2 : 1}`, base, `${maximum ? 'setup capture' : 'hold capture'} edge`);
    required.push(term(maximum ? 'Cell setup time' : 'Cell hold time', maximum ? 'Subtract setup requirement' : 'Add hold requirement', maximum ? -state.setup : state.hold));
    required.push(term(maximum ? 'Setup uncertainty' : 'Hold uncertainty', 'Residual uncertainty (jitter separate)', maximum ? -state.setupUncertainty : state.holdUncertainty));
    required.push(term(maximum ? 'Setup relative jitter' : 'Hold relative jitter', 'Relative launch/capture jitter bound', maximum ? -state.jitter : state.holdJitter));
    if (!output && maximum && branch.kind === 'latch') required.push(term('Borrow-budget restriction', `min(physical deadline ${current.physicalRequired}, open ${current.open} + allowed borrow ${current.allowedBorrow})`, current.required - current.physicalRequired));
    return { routeId, routes: maximum ? arc.setupRoutes : arc.holdRoutes, arrival: trace(arrival), required: trace(required), opening,
      slack: maximum ? current.setupSlack : current.holdSlack };
  }

  function analyze(state) {
    const result = previous.analyze(state);
    result.branches.forEach((view, index) => {
      const branch = state.branches[index];
      const phase = branch.nextPhase / 360 * state.period;
      const baseEdge = branch.nextPhase === 180 ? state.period + phase : branch.kind === 'latch' ? state.period : 2 * state.period;
      const baseHoldEdge = baseEdge - state.period;
      const second = view.second;
      second.baseEdge = baseEdge;
      second.baseHoldEdge = baseHoldEdge;
      second.edge = baseEdge + result.effective.branches[index].nextSkew;
      second.holdEdge = baseHoldEdge + result.effective.branches[index].nextSkew;
      second.required = second.edge - state.setup - result.setupMargin;
      second.holdRequired = second.holdEdge + state.hold + result.holdMargin;
      second.setupSlack = second.required - second.arrivalMax;
      second.holdSlack = second.arrivalMin - second.holdRequired;
      view.valid = view.first.valid && second.setupSlack >= -1e-8 && second.holdSlack >= -1e-8;
      view.first.breakdown = { setup: breakdown(state, branch, view, result, false, true), hold: breakdown(state, branch, view, result, false, false) };
      second.breakdown = { setup: breakdown(state, branch, view, result, true, true), hold: breakdown(state, branch, view, result, true, false) };
    });
    const checks = result.branches.flatMap(branch => [branch.first, branch.second]);
    result.worstSetup = Math.min(...checks.map(check => check.setupSlack));
    result.worstHold = Math.min(...checks.map(check => check.holdSlack));
    result.violations = checks.reduce((count, check) => count + (check.setupSlack < -1e-8) + (check.holdSlack < -1e-8), 0);
    result.valid = result.branches.every(branch => branch.valid);
    return result;
  }

  function challenge(index) {
    const state = previous.challenge(index);
    state.version = 4;
    state.branches.forEach(branch => { branch.nextPhase = 180; });
    return state;
  }

  function resizeFanout(state, count) {
    previous.resizeFanout(state, count);
    state.branches.forEach(branch => { if (branch.nextPhase === undefined) branch.nextPhase = 0; });
  }

  function validState(state) {
    return Boolean(state && state.version === 4 && Array.isArray(state.branches) && state.branches.every(branch => branch && [0, 180].includes(branch.nextPhase)) && previous.validState({ ...state, version: 3 }));
  }

  const api = { ...previous, defaults, analyze, challenge, resizeFanout, validState, clockTerms, routeTerms };
  if (commonJS) module.exports = api;
  else root.Timing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);