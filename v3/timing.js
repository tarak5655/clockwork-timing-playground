(function (root) {
  'use strict';
  const commonJS = typeof module !== 'undefined' && module.exports;
  const sta = commonJS ? require('../timing.js') : root.ClockworkSTA;
  const cells = commonJS ? require('../v2/timing.js') : root.Timing;
  const ROUTE_COUNT = 3;

  function randomSource(seed) {
    let value = seed >>> 0;
    return () => {
      value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
      return value / 4294967296;
    };
  }

  function randomRoutes(nominalCells, nominalWire, random) {
    const types = Object.keys(cells.LIBRARY);
    return [0.55, 0.9, 1.25].map(factor => {
      const count = Math.max(1, Math.min(cells.MAX_CELLS, Math.round(nominalCells * factor * (0.85 + random() * 0.3))));
      return {
        wire: Math.min(600, Math.round(nominalWire * (0.55 + random() * 0.9) / 5) * 5),
        cells: Array.from({ length: count }, () => cells.cell(types[Math.floor(random() * types.length)]))
      };
    });
  }

  function makeStage(arc, random) {
    return { nominalCells: arc.cells.length, nominalWire: arc.wire, routes: randomRoutes(arc.cells.length, arc.wire, random) };
  }

  function defaults(seed = Math.floor(Math.random() * 4294967296)) {
    const state = cells.defaults();
    state.version = 3;
    state.seed = seed >>> 0;
    const random = randomSource(state.seed);
    for (const branch of state.branches) {
      branch.input = makeStage(branch.input, random);
      branch.output = makeStage(branch.output, random);
    }
    return state;
  }

  function routeDelay(route, state) {
    const total = cells.chainDelay(route.cells);
    return sta.delay({ logicMin: total.min, logicMax: total.max, wire: route.wire, buffers: 0, size: 1, vt: 'LVT' }, state);
  }

  function parallelDelay(arc, state) {
    const routes = arc.routes.map((route, index) => ({ ...routeDelay(route, state), id: index + 1 }));
    const max = Math.max(...routes.map(route => route.max));
    const min = Math.min(...routes.map(route => route.min));
    const setupRoutes = routes.filter(route => Math.abs(route.max - max) < 1e-8).map(route => route.id);
    const holdRoutes = routes.filter(route => Math.abs(route.min - min) < 1e-8).map(route => route.id);
    return { max, min, routes, setupRoutes, holdRoutes, setupRoute: setupRoutes[0], holdRoute: holdRoutes[0],
      rawMax: Math.max(...routes.map(route => route.rawMax)), rawMin: Math.min(...routes.map(route => route.rawMin)) };
  }

  function singleRouteState(state, routeIndex = 0) {
    const result = cells.clone(state);
    result.version = 2;
    for (const branch of result.branches) {
      for (const key of ['input', 'output']) Object.assign(branch[key], branch[key].routes[routeIndex]);
    }
    return result;
  }

  function project(state) {
    const effective = cells.project(singleRouteState(state));
    for (let index = 0; index < state.branches.length; index++) {
      for (const key of ['input', 'output']) {
        const delay = parallelDelay(state.branches[index][key], state);
        Object.assign(effective.branches[index][key], { logicMin: delay.rawMin, logicMax: delay.rawMax, wire: 0, buffers: 0, size: 1, vt: 'LVT' });
      }
    }
    return effective;
  }

  function analyze(state) {
    const effective = project(state);
    const result = sta.analyze(effective);
    result.branches.forEach((branch, index) => {
      for (const key of ['input', 'output']) Object.assign(branch[key], parallelDelay(state.branches[index][key], state));
    });
    return { ...result, effective };
  }

  function randomizeStage(state, branchId, stage) {
    const arc = state.branches.find(branch => branch.id === branchId)[stage];
    state.seed = (state.seed + 2654435769) >>> 0;
    arc.routes = randomRoutes(arc.nominalCells, arc.nominalWire, randomSource(state.seed));
  }

  function resizeFanout(state, count) {
    cells.resizeFanout(state, count);
    const random = randomSource(state.seed);
    for (const branch of state.branches) {
      for (const key of ['input', 'output']) if (!branch[key].routes) branch[key] = makeStage(branch[key], random);
    }
  }

  function challenge(index) {
    const state = cells.challenge(index);
    state.version = 3;
    state.seed = index;
    for (const branch of state.branches) {
      for (const key of ['input', 'output']) {
        const arc = branch[key];
        branch[key] = { nominalCells: arc.cells.length, nominalWire: arc.wire,
          routes: Array.from({ length: ROUTE_COUNT }, (_, routeIndex) => ({ cells: cells.clone(arc.cells), wire: Math.max(0, arc.wire - routeIndex * 5) })) };
      }
    }
    return state;
  }

  function validState(state) {
    if (!state || state.version !== 3 || !Number.isInteger(state.seed) || state.seed < 0 || state.seed > 4294967295 || !Array.isArray(state.branches)) return false;
    if (!state.branches.every(branch => branch && ['input', 'output'].every(key => {
      const arc = branch[key];
      return arc && Number.isInteger(arc.nominalCells) && arc.nominalCells >= 1 && arc.nominalCells <= cells.MAX_CELLS &&
        Number.isFinite(arc.nominalWire) && arc.nominalWire >= 0 && arc.nominalWire <= 600 && Array.isArray(arc.routes) && arc.routes.length === ROUTE_COUNT && arc.routes.every(route => route && typeof route === 'object');
    }))) return false;
    return Array.from({ length: ROUTE_COUNT }, (_, index) => cells.validState(singleRouteState(state, index))).every(Boolean);
  }

  const api = { ...cells, ROUTE_COUNT, defaults, routeDelay, parallelDelay, project, analyze, randomizeStage, resizeFanout, challenge, validState };
  if (commonJS) module.exports = api;
  else root.Timing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);