(function (root) {
  'use strict';
  const commonJS = typeof module !== 'undefined' && module.exports;
  const previous = commonJS ? require('../v4/timing.js') : root.Timing;
  const term = (component, expression, value) => ({ component, expression, value });
  const falling = edge => edge === 'falling' ? 0.5 : 0;

  function configure(state) {
    state.version = 5;
    state.launchEdge = 'rising';
    state.branches.forEach(branch => { branch.firstEdge = 'rising'; branch.latchLevel = 'low'; branch.nextEdge = 'rising'; });
    return state;
  }

  function defaults(seed) { return configure(previous.defaults(seed)); }
  function challenge(index) { return configure(previous.challenge(index)); }

  function edgeAfter(reference, phase, period) {
    return (Math.floor(reference / period - phase + 1e-10) + 1 + phase) * period;
  }

  function schedule(state, branch) {
    const period = state.period;
    const launch = falling(state.launchEdge) * period;
    const latch = branch.kind === 'latch';
    const capturePhase = latch ? branch.latchLevel === 'high' ? 0.5 : 0 : falling(branch.firstEdge);
    const firstCapture = edgeAfter(launch, capturePhase, period);
    const holdOpen = firstCapture - period / 2;
    const open = latch ? edgeAfter(launch, branch.latchLevel === 'high' ? 0 : 0.5, period) : holdOpen;
    const capture = latch ? open + period / 2 : firstCapture;
    const nextPhase = (branch.nextPhase / 360 + falling(branch.nextEdge)) % 1;
    const next = edgeAfter(latch ? open : capture, nextPhase, period);
    const nextHold = edgeAfter(latch ? holdOpen : firstCapture, nextPhase, period) - period;
    return { launch, capture, hold: firstCapture - period, open, holdOpen, next, nextHold };
  }

  function trace(rows) {
    let total = 0;
    return { rows: rows.map(row => ({ ...row, total: total += row.value })), total };
  }

  function breakdown(state, branch, view, result, output, maximum) {
    const current = output ? view.second : view.first;
    const arc = view[output ? 'output' : 'input'];
    const routeId = maximum ? arc.setupRoute : arc.holdRoute;
    const suffix = maximum ? 'Max' : 'Min';
    let arrival;
    let opening = null;
    if (!output) {
      arrival = [...previous.clockTerms(state, 'L', view.schedule.launch, `${state.launchEdge} launch edge`),
        term('Launch FF clock-to-Q', `CQ ${maximum ? 'max' : 'min'}`, state[`cq${suffix}`]),
        term('Launch fanout', `${state.branches.length - 1} extra branches * ${maximum ? 6 : 3}`, result[`fanout${suffix}`])];
    } else if (branch.kind === 'ff') {
      arrival = [...previous.clockTerms(state, `${branch.id}1`, view.schedule.capture, `${branch.firstEdge} relaunch edge`),
        term(`${branch.id}1 FF clock-to-Q`, `CQ ${maximum ? 'max' : 'min'}`, state[`cq${suffix}`])];
    } else {
      arrival = view.first.breakdown[maximum ? 'setup' : 'hold'].arrival.rows.map(({ component, expression, value }) => term(component, expression, value));
      const baseOpen = view.schedule[maximum ? 'open' : 'holdOpen'];
      const latchOpen = view.first[maximum ? 'open' : 'holdOpen'];
      opening = trace(previous.clockTerms(state, `${branch.id}1`, baseOpen, `${branch.latchLevel}-level latch ${maximum ? 'setup' : 'hold'} opening`));
      const inputArrival = view.first[`arrival${suffix}`];
      arrival.push(term('Wait for latch opening', `max(${latchOpen}, ${inputArrival}) - ${inputArrival}`, Math.max(0, latchOpen - inputArrival)));
      arrival.push(term('Latch transfer', `DQ ${maximum ? 'max' : 'min'}; max(open, input arrival) + DQ`, state[`dq${suffix}`]));
    }
    arrival.push(...previous.routeTerms(branch[output ? 'output' : 'input'].routes[routeId - 1], state, maximum, `${branch.id}${output ? 2 : 1} P${routeId}`));
    const base = current[maximum ? 'baseEdge' : 'baseHoldEdge'];
    const required = previous.clockTerms(state, `${branch.id}${output ? 2 : 1}`, base, `${maximum ? 'setup capture' : 'hold capture'} edge`);
    required.push(term(maximum ? 'Cell setup time' : 'Cell hold time', maximum ? 'Subtract setup requirement' : 'Add hold requirement', maximum ? -state.setup : state.hold));
    required.push(term(maximum ? 'Setup uncertainty' : 'Hold uncertainty', 'Residual uncertainty (jitter separate)', maximum ? -state.setupUncertainty : state.holdUncertainty));
    required.push(term(maximum ? 'Setup relative jitter' : 'Hold relative jitter', 'Relative launch/capture jitter bound', maximum ? -state.jitter : state.holdJitter));
    if (!output && maximum && branch.kind === 'latch') required.push(term('Borrow-budget restriction', `min(physical deadline ${current.physicalRequired}, open ${current.open} + allowed borrow ${current.allowedBorrow})`, current.required - current.physicalRequired));
    return { routeId, routes: maximum ? arc.setupRoutes : arc.holdRoutes, arrival: trace(arrival), required: trace(required), opening,
      slack: maximum ? current.setupSlack : current.holdSlack };
  }

  function analyze(state) {
    const effective = previous.project(state);
    const setupMargin = state.setupUncertainty + state.jitter;
    const holdMargin = state.holdUncertainty + state.holdJitter;
    const fanoutMax = 6 * (state.branches.length - 1);
    const fanoutMin = 3 * (state.branches.length - 1);
    const launchEdge = falling(state.launchEdge) * state.period + effective.launchSkew;
    const launchMax = launchEdge + state.cqMax + fanoutMax;
    const launchMin = launchEdge + state.cqMin + fanoutMin;
    const result = { effective, setupMargin, holdMargin, fanoutMax, fanoutMin, launchEdge, launchMax, launchMin };
    result.branches = state.branches.map((branch, index) => {
      const clock = effective.branches[index];
      const edges = schedule(state, branch);
      const input = previous.parallelDelay(branch.input, state);
      const output = previous.parallelDelay(branch.output, state);
      const arrivalMax = launchMax + input.max;
      const arrivalMin = launchMin + input.min;
      const close = edges.capture + clock.skew;
      const open = edges.open + clock.skew;
      const holdOpen = edges.holdOpen + clock.skew;
      const latch = branch.kind === 'latch';
      const physicalRequired = close - state.setup - setupMargin;
      const allowedBorrow = latch ? Math.max(0, Math.min(state.borrowing ? state.borrowLimit : 0, physicalRequired - open)) : 0;
      const required = latch ? Math.min(physicalRequired, open + allowedBorrow) : physicalRequired;
      const holdEdge = edges.hold + clock.skew;
      const holdRequired = holdEdge + state.hold + holdMargin;
      const setupSlack = required - arrivalMax;
      const holdSlack = arrivalMin - holdRequired;
      const valid = setupSlack >= -1e-8 && holdSlack >= -1e-8;
      const first = { arrivalMax, arrivalMin, required, physicalRequired, holdRequired, setupSlack, holdSlack,
        edge: close, holdEdge, open, holdOpen, close, baseEdge: edges.capture, baseHoldEdge: edges.hold, baseOpen: edges.open, baseHoldOpen: edges.holdOpen,
        borrowed: latch ? Math.max(0, arrivalMax - open) : 0, allowedBorrow, valid };
      const qMax = latch ? Math.max(open, arrivalMax) + state.dqMax : close + state.cqMax;
      const qMin = latch ? Math.max(holdOpen, arrivalMin) + state.dqMin : close + state.cqMin;
      const edge = edges.next + clock.nextSkew;
      const nextHoldEdge = edges.nextHold + clock.nextSkew;
      const second = { arrivalMax: qMax + output.max, arrivalMin: qMin + output.min,
        required: edge - state.setup - setupMargin, holdRequired: nextHoldEdge + state.hold + holdMargin,
        edge, holdEdge: nextHoldEdge, baseEdge: edges.next, baseHoldEdge: edges.nextHold, provisional: !valid };
      second.setupSlack = second.required - second.arrivalMax;
      second.holdSlack = second.arrivalMin - second.holdRequired;
      const view = { id: branch.id, kind: branch.kind, schedule: edges, input, output, first, second, qMax, qMin,
        valid: valid && second.setupSlack >= -1e-8 && second.holdSlack >= -1e-8 };
      first.breakdown = { setup: breakdown(state, branch, view, result, false, true), hold: breakdown(state, branch, view, result, false, false) };
      second.breakdown = { setup: breakdown(state, branch, view, result, true, true), hold: breakdown(state, branch, view, result, true, false) };
      return view;
    });
    const checks = result.branches.flatMap(branch => [branch.first, branch.second]);
    result.worstSetup = Math.min(...checks.map(check => check.setupSlack));
    result.worstHold = Math.min(...checks.map(check => check.holdSlack));
    result.violations = checks.reduce((count, check) => count + (check.setupSlack < -1e-8) + (check.holdSlack < -1e-8), 0);
    result.valid = result.branches.every(branch => branch.valid);
    return result;
  }

  function resizeFanout(state, count) {
    previous.resizeFanout(state, count);
    state.branches.forEach(branch => {
      if (!branch.firstEdge) { branch.firstEdge = 'rising'; branch.latchLevel = 'low'; branch.nextEdge = 'rising'; }
    });
  }

  function validState(state) {
    return Boolean(state && state.version === 5 && ['rising', 'falling'].includes(state.launchEdge) &&
      Array.isArray(state.branches) && state.branches.every(branch => branch && ['rising', 'falling'].includes(branch.firstEdge) &&
        ['rising', 'falling'].includes(branch.nextEdge) && ['low', 'high'].includes(branch.latchLevel)) &&
      previous.validState({ ...state, version: 4 }));
  }

  function playbackEvents(state, check = 'setup') {
    const result = analyze(state);
    const duration = 3 * state.period;
    const maximum = check === 'setup';
    const events = [];
    for (const [id, path] of Object.entries(state.clockPaths)) {
      const branch = state.branches.find(item => item.id === id[0]);
      if (id !== 'L' && !branch) continue;
      const offset = id === 'L' ? state.launchSkew : branch[id.endsWith('1') ? 'skew' : 'nextSkew'];
      const phase = id.endsWith('2') ? branch.nextPhase / 360 * state.period : 0;
      const delay = previous.clockDelay(path);
      const firstCycle = Math.floor((-delay - offset - phase) / state.period) - 1;
      for (let cycle = firstCycle; cycle <= 3; cycle++) {
        for (const transition of ['rising', 'falling']) {
          const from = cycle * state.period + phase + offset + falling(transition) * state.period;
          const to = from + delay;
          if (from <= duration && to >= 0) events.push({ signal: 'clock', endpoint: id, pathId: `clock-route-${id}`, cycle, transition, from, to, enabled: true });
        }
      }
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const branch of result.branches) {
        for (const key of ['input', 'output']) {
          const release = key === 'input' ? result[maximum ? 'launchMax' : 'launchMin'] : branch[maximum ? 'qMax' : 'qMin'];
          for (const [index, route] of branch[key].routes.entries()) {
            const from = release + cycle * state.period;
            events.push({ signal: 'data', endpoint: `${branch.id}${key === 'input' ? 1 : 2}`, pathId: `net-${branch.id}-${key}-${index}`,
              cycle, route: index + 1, from, to: from + route[maximum ? 'max' : 'min'], enabled: key === 'input' || branch.first.valid });
          }
        }
      }
    }
    events.sort((left, right) => left.from - right.from || left.to - right.to || left.pathId.localeCompare(right.pathId));
    return { duration, events, result };
  }

  function eventProgress(event, time) {
    if (!event.enabled || time < event.from) return null;
    return event.to === event.from ? 1 : Math.max(0, Math.min(1, (time - event.from) / (event.to - event.from)));
  }

  const api = { ...previous, defaults, challenge, schedule, analyze, resizeFanout, validState, playbackEvents, eventProgress };
  if (commonJS) module.exports = api;
  else root.Timing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);