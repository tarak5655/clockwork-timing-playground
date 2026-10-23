(function () {
  'use strict';
  const { defaults, analyze, clone, challenge } = Timing;
  const byId = id => document.getElementById(id);
  const fmt = value => (Object.is(Number(value.toFixed(2)), -0) ? 0 : value).toFixed(2);
  const signed = value => `${value >= -1e-8 ? '+' : ''}${fmt(value)}`;
  const color = value => value >= -1e-8 ? '#16765b' : '#b83f3d';
  const cls = value => value >= -1e-8 ? 'good' : 'bad';
  const storageKey = 'clockwork-v5';
  let state = defaults();
  let selected = 'A';
  let stage = 'input';
  let selectedRoute = 0;
  let check = 'setup';
  let mode = 'sandbox';
  let missionIndex = 1;
  let moves = 0;
  let history = [];
  let completed = [];
  let sandbox = null;
  let expanded = null;
  let selectedCell = 0;
  let pendingClick = null;
  let lastChange = 'Baseline: LVT, 1x drive. Select a path to inspect its timing budget.';
  let storageAvailable = true;
  const missions = [
    { title: 'Beat all three setup paths', goal: 'Close every timing check. All three A / Stage 1 routes must meet setup without breaking hold.', hint: 'Set the drive to 2x on P1, P2 and P3 of A / Stage 1. The critical route can change as you speed up each chain.', rule: () => true },
    { title: 'The fastest route wins hold', goal: 'Close every timing check and add a buffer on each A / Stage 1 route. A remaining fast route can still violate hold.', hint: 'Add five LVT / 1x BUF cells to EACH of P1, P2 and P3 on A / Stage 1. Hold takes the smallest minimum, not the route selected in the editor.', rule: () => state.branches[0].input.routes.every(route => route.cells.some(instance => instance.type === 'BUF')) },
    { title: 'Shared skew, parallel paths', goal: 'Close every timing check with A capture skew at +40 ps or later. All three following half-cycle routes must pass too.', hint: 'Try +60 ps on A1 clock offset and 3x drive on EACH route of A / Stage 2. All routes share their launch and capture clocks.', rule: result => result.effective.branches[0].skew - result.effective.launchSkew >= 40 },
    { title: 'Borrow from the slowest route', goal: 'Enable borrowing and close every check while latch A borrows at least 100 ps. All routes to the next FF must pass.', hint: 'Enable borrowing with at least 230 ps budget, then set EACH A / Stage 2 route to 2x drive. The slowest incoming route borrows 226 ps.', rule: result => state.borrowing && result.branches[0].first.borrowed >= 100 },
    { title: 'Three routes, one noisy corner', goal: 'Close every check with 45 ps noise, 35 ps relative setup jitter, and 10% early/late variation.', hint: 'On ALL THREE routes: use 2x drive for A / Stage 1 and both Stage 2 paths; add four LVT / 1x BUF cells to each B / Stage 1 route.', rule: () => true }
  ];

  function validSaved(value) {
    return Timing.validState(value);
  }

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && validSaved(saved.state)) state = saved.state;
    if (saved && Array.isArray(saved.completed)) completed = saved.completed.filter(number => Number.isInteger(number) && number >= 1 && number <= 5);
  } catch { storageAvailable = false; }

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ state: mode === 'sandbox' ? state : sandbox, completed }));
      storageAvailable = true;
    } catch { storageAvailable = false; }
    byId('save-status').textContent = storageAvailable ? 'Sandbox autosaved' : 'Session only';
  }

  function currentBranch() { return state.branches.find(branch => branch.id === selected) || state.branches[0]; }
  function currentPath() { return currentBranch()[stage].routes[selectedRoute]; }
  function routeNames(ids) { return ids.map(id => `P${id}`).join(', '); }
  function selectedResult(result) { return result.branches.find(branch => branch.id === selected) || result.branches[0]; }
  function checkResult(result) { const branch = selectedResult(result); return stage === 'input' ? branch.first : branch.second; }

  function snapshot() { return { state: clone(state), moves, lastChange }; }
  function edit(action, label) {
    const before = checkResult(analyze(state));
    history.push(snapshot());
    if (history.length > 80) history.shift();
    action();
    moves++;
    const after = checkResult(analyze(state));
    lastChange = `${label} | Selected path: setup ${signed(after.setupSlack - before.setupSlack)} ps, hold ${signed(after.holdSlack - before.holdSlack)} ps versus before.`;
    render();
    save();
  }

  function range(id, label, value, min, max, step, scope, key, unit = 'ps', disabled = false) {
    const attributes = `data-scope="${scope}" data-key="${key}" min="${min}" max="${max}" step="${step}" ${disabled ? 'disabled' : ''}`;
    return `<div class="range-field"><div class="range-top"><label for="${id}">${label}</label><span class="number-wrap"><input id="${id}-value" type="number" value="${value}" ${attributes} aria-label="${label} value"><span>${unit}</span></span></div><input id="${id}" type="range" value="${value}" ${attributes} aria-label="${label}"></div>`;
  }

  function renderControls(result) {
    const branch = currentBranch();
    const arc = currentPath();
    const view = selectedResult(result);
    const locked = mode === 'challenge';
    byId('selected-title').textContent = `Path ${selected} / Stage ${stage === 'input' ? 1 : 2}`;
    byId('selected-tag').textContent = `${selected}${stage === 'input' ? 1 : 2}`;
    byId('branch-select').innerHTML = state.branches.map(item => `<option ${item.id === selected ? 'selected' : ''}>${item.id}</option>`).join('');
    byId('stage-select').value = stage;
    byId('element-name').textContent = stage === 'input' ? `${branch.kind === 'latch' ? `LATCH ${branch.latchLevel.toUpperCase()}` : `FF ${branch.firstEdge === 'rising' ? 'RISE' : 'FALL'}`} ${selected}1` : `FF ${branch.nextEdge === 'rising' ? 'RISE' : 'FALL'} ${selected}2 / ${branch.nextPhase} deg`;
    for (const [id, key] of [['launch-edge', 'launchEdge'], ['first-edge', 'firstEdge'], ['latch-level', 'latchLevel'], ['next-edge', 'nextEdge']]) {
      byId(id).value = key === 'launchEdge' ? state[key] : branch[key];
      byId(id).disabled = locked;
    }
    byId('first-edge-control').hidden = branch.kind === 'latch';
    byId('latch-level-control').hidden = branch.kind !== 'latch';
    byId('next-phase').value = branch.nextPhase;
    byId('next-phase').disabled = locked;
    document.querySelectorAll('[data-kind]').forEach(button => {
      button.classList.toggle('active', button.dataset.kind === branch.kind);
      button.setAttribute('aria-pressed', String(button.dataset.kind === branch.kind));
      button.disabled = stage === 'output' || locked;
    });
    byId('kind-control').hidden = stage === 'output';
    const skewKey = stage === 'input' ? 'skew' : 'nextSkew';
    const sourceName = stage === 'input' ? 'L' : `${selected}1`;
    const captureName = `${selected}${stage === 'input' ? 1 : 2}`;
    byId('skew-control').innerHTML =
      range('launch-skew', `Launch clock offset / ${sourceName}`, stage === 'input' ? state.launchSkew : branch.skew,
        stage === 'input' ? -120 : -200, stage === 'input' ? 120 : 200, 5,
        stage === 'input' ? 'global' : 'branch', stage === 'input' ? 'launchSkew' : 'skew', 'ps', locked && stage === 'input') +
      range('capture-skew', `Capture clock offset / ${captureName}`, branch[skewKey], -200, 200, 5, 'branch', skewKey);
    byId('path-controls').innerHTML =
      `<p class="cell-count-summary">EDITING P${selectedRoute + 1} / ${arc.cells.length} cells / ${fmt(Timing.chainDelay(arc.cells).min)} min, ${fmt(Timing.chainDelay(arc.cells).max)} max ps before wire</p>` +
      range('wire-delay', `P${selectedRoute + 1} net delay / max`, arc.wire, 0, 600, 5, 'path', 'wire');
    byId('expand-data').textContent = `Expand P${selectedRoute + 1} cells`;
    const bufferCount = arc.cells.filter(instance => instance.type === 'BUF').length;
    byId('buffer-count').textContent = bufferCount;
    byId('remove-buffer').disabled = bufferCount === 0;
    byId('add-buffer').disabled = arc.cells.length >= Timing.MAX_CELLS;
    byId('drive-size').value = new Set(arc.cells.map(instance => instance.size)).size === 1 ? arc.cells[0].size : 'mixed';
    byId('vt').value = new Set(arc.cells.map(instance => instance.vt)).size === 1 ? arc.cells[0].vt : 'mixed';
    byId('drive-size').disabled = arc.cells.length === 0;
    byId('vt').disabled = arc.cells.length === 0;
    byId('clock-controls').innerHTML =
      range('clock-period', 'Clock period', state.period, 600, 2400, 20, 'global', 'period', 'ps', locked) +
      range('setup-uncertainty', 'Setup uncertainty', state.setupUncertainty, 0, 150, 5, 'global', 'setupUncertainty', 'ps', locked) +
      range('hold-uncertainty', 'Hold uncertainty', state.holdUncertainty, 0, 150, 5, 'global', 'holdUncertainty', 'ps', locked) +
      range('setup-jitter', 'Relative jitter / setup', state.jitter, 0, 150, 5, 'global', 'jitter', 'ps', locked) +
      range('hold-jitter', 'Relative jitter / hold', state.holdJitter, 0, 100, 5, 'global', 'holdJitter', 'ps', locked);
    byId('noise-controls').innerHTML =
      range('noise', 'Noise delay bound (+/-)', state.noise, 0, 150, 5, 'global', 'noise', 'ps', locked) +
      range('late-derate', 'Late OCV derate', state.lateDerate, 0, 30, 1, 'global', 'lateDerate', '%', locked) +
      range('early-derate', 'Early OCV derate', state.earlyDerate, 0, 30, 1, 'global', 'earlyDerate', '%', locked);
    byId('borrowing').checked = state.borrowing;
    byId('borrowing').disabled = locked && missionIndex !== 4;
    byId('borrow-control').innerHTML = range('borrow-limit', 'Maximum borrow budget', state.borrowLimit, 0, 1200, 10, 'global', 'borrowLimit', 'ps', !state.borrowing || (locked && missionIndex !== 4));
    if (branch.kind === 'latch') {
      const first = view.first;
      byId('borrow-meter').innerHTML = `${fmt(first.borrowed)} / ${fmt(first.allowedBorrow)} ps borrowed<div class="borrow-track"><div class="borrow-fill" style="width:${Math.min(100, 100 * first.borrowed / Math.max(1, first.allowedBorrow))}%"></div></div>Transparent: ${fmt(first.open)} to ${fmt(first.close)} ps`;
    } else byId('borrow-meter').textContent = 'Selected receiver is an edge-triggered FF: no borrowing.';
    byId('cell-controls').innerHTML =
      range('cell-setup', 'Cell setup time', state.setup, 0, 150, 5, 'global', 'setup', 'ps', locked) +
      range('cell-hold', 'Cell hold time', state.hold, 0, 120, 5, 'global', 'hold', 'ps', locked) +
      range('cq-max', 'FF clock-to-Q / max', state.cqMax, 0, 200, 1, 'global', 'cqMax', 'ps', locked) +
      range('cq-min', 'FF clock-to-Q / min', state.cqMin, 0, 200, 1, 'global', 'cqMin', 'ps', locked) +
      range('dq-max', 'Latch transfer / max', state.dqMax, 0, 150, 1, 'global', 'dqMax', 'ps', locked) +
      range('dq-min', 'Latch transfer / min', state.dqMin, 0, 150, 1, 'global', 'dqMin', 'ps', locked);
    byId('fanout').value = state.branches.length;
    byId('fanout').disabled = locked;
    byId('delay-summary').textContent = `${fmt(view[stage].min)} / ${fmt(view[stage].max)} ps`;
  }

  function routeTable(arc) {
    return `<table class="route-summary-table"><thead><tr><th>Path</th><th>Min ps</th><th>Max ps</th><th>Controls</th></tr></thead><tbody>${arc.routes.map((route, index) => `<tr class="${index === selectedRoute ? 'current-route' : ''}" data-route-summary="${route.id}"><td><button class="route-pick" data-route-pick="${index}" aria-label="Edit route P${route.id}" aria-pressed="${index === selectedRoute}">P${route.id}</button></td><td>${fmt(route.min)}</td><td>${fmt(route.max)}</td><td>${arc.setupRoutes.includes(route.id) ? '<span class="critical-role setup-critical">SETUP</span>' : ''}${arc.holdRoutes.includes(route.id) ? '<span class="critical-role hold-critical">HOLD</span>' : ''}${!arc.setupRoutes.includes(route.id) && !arc.holdRoutes.includes(route.id) ? '-' : ''}</td></tr>`).join('')}</tbody></table>`;
  }

  function renderRoutes(result) {
    const arc = selectedResult(result)[stage];
    byId('route-summary').innerHTML = routeTable(arc);
    byId('route-select').value = selectedRoute;
    byId('randomize-paths').disabled = mode === 'challenge';
    byId('critical-summary').textContent = `Setup: ${routeNames(arc.setupRoutes)} = ${fmt(arc.max)} ps max. Hold: ${routeNames(arc.holdRoutes)} = ${fmt(arc.min)} ps min.`;
  }

  function node(x, y, id, label, sublabel, latch, active, failed, branchId, selectedStage, timingValue, relativeSkew, inverted = false) {
    const stroke = active ? '#16765b' : failed ? '#bf7770' : '#c4d2ca';
    const fill = latch ? '#fff7dd' : active ? '#e7f4ec' : '#ffffff';
    return `<g class="circuit-node sequential-node" data-endpoint="${branchId ? `${branchId}${selectedStage === 'input' ? 1 : 2}` : 'L'}" ${branchId ? `data-select="${branchId}" data-stage="${selectedStage}" tabindex="0" role="button" aria-label="Select ${id}"` : ''}>
      <rect class="node-body" x="${x}" y="${y - 32}" width="90" height="64" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="${active ? 2 : 1.5}"/>
      <text class="circuit-text circuit-title" x="${x + 45}" y="${y - 7}" text-anchor="middle">${id}</text>
      <text class="circuit-mono" x="${x + 45}" y="${y + 11}" text-anchor="middle">${label}</text>
      <text class="circuit-mono" x="${x + 45}" y="${y + 51}" text-anchor="middle">${sublabel}</text>
      <circle class="clock-pin" cx="${x + 70}" cy="${y + 32}" r="2" fill="#347da3"/>
      ${inverted ? `<circle class="clock-inversion" cx="${x + 70}" cy="${y + 36}" r="3.5" fill="white" stroke="#347da3"/>` : ''}
      ${latch ? `<text class="circuit-mono" x="${x + 70}" y="${y + 26}" text-anchor="middle" style="fill:#347da3;font-size:8px">G</text>` : `<path class="clock-triangle" d="M ${x + 63} ${y + 32} l 7 -9 l 7 9" fill="none" stroke="#347da3"/>`}
      ${failed ? `<circle cx="${x + 83}" cy="${y - 26}" r="4" fill="#b83f3d"/>` : ''}
      ${timingValue ? `<g class="capture-timing" data-timing="${branchId}${selectedStage === 'input' ? 1 : 2}">
        <text class="circuit-mono" data-edge="setup" x="${x + 45}" y="${y + 67}" text-anchor="middle">Setup edge ${fmt(timingValue.edge)} ps</text>
        <text class="circuit-mono" data-edge="hold" x="${x + 45}" y="${y + 83}" text-anchor="middle">Hold edge ${fmt(timingValue.holdEdge)} ps</text>
        <text class="circuit-mono" x="${x + 45}" y="${y + 99}" text-anchor="middle">SKEW ${signed(relativeSkew)} ps</text>
        <text class="circuit-mono" data-slack="setup" x="${x + 45}" y="${y + 115}" text-anchor="middle" style="fill:${color(timingValue.setupSlack)}">Setup slack ${signed(timingValue.setupSlack)} ps</text>
        <text class="circuit-mono" data-slack="hold" x="${x + 45}" y="${y + 131}" text-anchor="middle" style="fill:${color(timingValue.holdSlack)}">Hold slack ${signed(timingValue.holdSlack)} ps</text>
        ${timingValue.provisional ? `<text class="circuit-mono" x="${x + 45}" y="${y + 147}" text-anchor="middle" style="fill:#80620f">PROVISIONAL</text>` : ''}
      </g>` : ''}</g>`;
  }

  function expandedPath() {
    return expanded.kind === 'clock' ? state.clockPaths[expanded.id] : state.branches.find(branch => branch.id === expanded.id)?.[expanded.stage].routes[selectedRoute];
  }

  function openEditor(descriptor) {
    clearTimeout(pendingClick);
    expanded = descriptor;
    selectedCell = 0;
    if (descriptor.route !== undefined) selectedRoute = descriptor.route;
    if (descriptor.kind === 'data') { selected = descriptor.id; stage = descriptor.stage; }
    else if (descriptor.id === 'L') stage = 'input';
    else { selected = descriptor.id[0]; stage = descriptor.contextStage || (descriptor.id.endsWith('1') ? 'input' : 'output'); }
    render();
    byId('path-editor').showModal();
    renderEditor(analyze(state));
    byId('close-editor').focus({ preventScroll: true });
  }

  function openFromElement(element) {
    openEditor(element.dataset.expand === 'clock' ? { kind: 'clock', id: element.dataset.pathId } :
      { kind: 'data', id: element.dataset.select, stage: element.dataset.stage, route: Number(element.dataset.route || 0) });
  }

  function gateSymbol(type, tone) {
    const inverted = ['NAND', 'NOR', 'NOT'].includes(type);
    const single = ['BUF', 'NOT'].includes(type);
    const shape = single ? 'M -25 -20 L 19 0 L -25 20 Z' :
      ['AND', 'NAND'].includes(type) ? 'M -25 -20 H -2 A 20 20 0 0 1 -2 20 H -25 Z' :
        'M -28 -20 Q 1 -22 22 0 Q 1 22 -28 20 Q -13 0 -28 -20 Z';
    const leads = single ? '<path d="M -59 0 H -25"/>' :
      `<path d="M -59 0 H -36 V -10 H -24 M -39 12 H -24"/><text x="-42" y="16" text-anchor="end" stroke="none" fill="${tone}" font-size="8">${['AND', 'NAND'].includes(type) ? '1' : '0'}</text>`;
    return `<g fill="white" stroke="${tone}" stroke-width="1.8">${leads}<path d="${shape}"/>${inverted ? '<circle cx="24" cy="0" r="4"/>' : ''}<path d="M ${inverted ? 28 : single ? 19 : 22} 0 H 59"/></g>`;
  }

  function renderEditor(result) {
    if (!expanded) return;
    const path = expandedPath();
    if (!path) { byId('path-editor').close(); return; }
    const clock = expanded.kind === 'clock';
    const total = Timing.chainDelay(path.cells);
    const current = checkResult(result);
    const tone = clock ? '#347da3' : '#16765b';
    selectedCell = Math.max(0, Math.min(selectedCell, path.cells.length - 1));
    const focused = document.activeElement;
    const focusedRow = focused.closest('[data-cell-index]')?.dataset.cellIndex;
    const focusedField = focused.dataset.cellField;
    const descriptor = clock ? `${expanded.id} clock chain` : `${expanded.id} / Stage ${expanded.stage === 'input' ? 1 : 2} / P${selectedRoute + 1}`;
    byId('editor-title').textContent = descriptor;
    byId('editor-eyebrow').textContent = clock ? 'CLOCK NETWORK / NOMINAL DELAY' : 'DATA NETWORK / MIN AND MAX DELAY';
    const effectiveBranch = result.effective.branches.find(branch => branch.id === selected);
    const offset = clock ? expanded.id === 'L' ? state.launchSkew : currentBranch()[expanded.id.endsWith('1') ? 'skew' : 'nextSkew'] : 0;
    const latency = total.nominal + path.wire + offset;
    const arc = selectedResult(result)[stage];
    const route = clock ? null : arc.routes[selectedRoute];
    byId('editor-parallel').hidden = clock;
    if (!clock) {
      byId('editor-route-select').value = selectedRoute;
      byId('editor-route-summary').innerHTML = routeTable(arc);
    }
    const metrics = clock ? [['BUFFER SUM', total.nominal], ['CLOCK LATENCY', latency]] : [['STAGE MINIMUM', arc.min], ['STAGE MAXIMUM', arc.max]];
    byId('editor-metrics').innerHTML = metrics.map(([label, value]) => `<div><span>${label}</span><strong>${fmt(value)} <small>ps</small></strong></div>`).join('') +
      `<div><span>${selected}${stage === 'input' ? 1 : 2} SETUP ${current.provisional ? '/ PROVISIONAL' : ''}</span><strong class="${cls(current.setupSlack)}">${signed(current.setupSlack)} <small>ps</small></strong></div><div><span>${selected}${stage === 'input' ? 1 : 2} HOLD ${current.provisional ? '/ PROVISIONAL' : ''}</span><strong class="${cls(current.holdSlack)}">${signed(current.holdSlack)} <small>ps</small></strong></div>`;
    const width = Math.max(650, path.cells.length * 140 + 170);
    const source = clock ? 'CLK ROOT' : stage === 'input' ? 'FF L / Q' : `${selected}1 / Q`;
    const receiver = clock ? `${expanded.id} / CLK` : `${selected}${stage === 'input' ? 1 : 2} / D`;
    const spacing = path.cells.length ? (width - 170) / path.cells.length : 140;
    byId('expanded-chain').setAttribute('viewBox', `0 0 ${width} 180`);
    byId('expanded-chain').style.width = `${width}px`;
    byId('expanded-chain').innerHTML = `<path d="M 35 90 H ${width - 35}" stroke="${tone}" stroke-width="2" ${clock ? 'stroke-dasharray="5 3"' : ''}/><circle cx="35" cy="90" r="4" fill="${tone}"/><circle cx="${width - 35}" cy="90" r="4" fill="${tone}"/><text x="20" y="165" class="circuit-mono">${source}</text><text x="${width - 20}" y="165" text-anchor="end" class="circuit-mono">${receiver}</text>` + path.cells.map((instance, index) => {
      const delay = Timing.cellDelay(instance);
      return `<g class="chain-cell" data-chain-cell="${index}" tabindex="0" role="button" aria-label="Cell ${index + 1}: ${instance.type}, ${instance.size}x, ${instance.vt}" transform="translate(${120 + spacing * index} 90)"><rect x="-59" y="-68" width="118" height="130" rx="4" fill="${index === selectedCell ? clock ? '#e7f2fb' : '#e5f2e8' : '#fbfdfb'}" stroke="${index === selectedCell ? tone : 'none'}"/><text class="circuit-mono" y="-47" text-anchor="middle" style="fill:${tone}">U${index + 1} / ${instance.type}</text>${gateSymbol(instance.type, tone)}<text class="circuit-mono" y="38" text-anchor="middle">${instance.size}x / ${instance.vt}</text><text class="circuit-mono" y="54" text-anchor="middle">${clock ? fmt(delay.nominal) : `${fmt(delay.min)} / ${fmt(delay.max)}`} ps</text></g>`;
    }).join('');
    if (path.cells.length === 0) byId('expanded-chain').innerHTML += `<text x="${width / 2}" y="63" text-anchor="middle" class="circuit-mono">WIRE ONLY / NO CELLS</text>`;
    const options = clock ? ['BUF'] : Object.keys(Timing.LIBRARY);
    const previousType = byId('new-cell-type').value;
    byId('new-cell-type').innerHTML = options.map(type => `<option>${type}</option>`).join('');
    byId('new-cell-type').value = options.includes(previousType) ? previousType : 'BUF';
    byId('new-cell-type').disabled = clock;
    byId('editor-wire').value = path.wire;
    byId('cell-count').textContent = `${path.cells.length} / ${Timing.MAX_CELLS} cells`;
    byId('insert-cell').disabled = path.cells.length >= Timing.MAX_CELLS;
    byId('insert-cell').title = path.cells.length ? `Insert after cell U${selectedCell + 1}` : 'Insert first cell';
    byId('editor-undo').disabled = history.length === 0;
    const selectOptions = (values, selectedValue, suffix = '') => values.map(value => `<option value="${value}" ${value === selectedValue ? 'selected' : ''}>${value}${suffix}</option>`).join('');
    byId('cell-list').innerHTML = path.cells.length ? path.cells.map((instance, index) => {
      const delay = Timing.cellDelay(instance);
      return `<div class="cell-row ${index === selectedCell ? 'is-selected' : ''}" data-cell-index="${index}"><button class="cell-id" data-row-action="select" aria-label="Select cell ${index + 1}">U${index + 1}</button><label>Cell type<select data-cell-field="type" aria-label="U${index + 1} cell type" ${clock ? 'disabled' : ''}>${selectOptions(options, instance.type)}</select></label><label>Drive size<select data-cell-field="size" aria-label="U${index + 1} drive size">${selectOptions(Timing.SIZES, instance.size, 'x')}</select></label><label>VT flavor<select data-cell-field="vt" aria-label="U${index + 1} VT flavor">${selectOptions(Object.keys(Timing.VT), instance.vt)}</select></label><span class="cell-delay">${clock ? 'NOMINAL' : 'MIN / MAX'}<br><b>${clock ? fmt(delay.nominal) : `${fmt(delay.min)} / ${fmt(delay.max)}`} ps</b></span><div class="cell-row-actions"><button class="icon-button" data-row-action="up" title="Move cell earlier" aria-label="Move U${index + 1} earlier" ${index === 0 ? 'disabled' : ''}>&#8593;</button><button class="icon-button" data-row-action="down" title="Move cell later" aria-label="Move U${index + 1} later" ${index === path.cells.length - 1 ? 'disabled' : ''}>&#8595;</button><button class="icon-button" data-row-action="remove" title="Remove cell" aria-label="Remove U${index + 1}">&#215;</button></div></div>`;
    }).join('') : '<p class="empty-chain">No cells. Path contains wire delay only.</p>';
    if (focusedRow !== undefined && focusedField) byId('cell-list').querySelector(`[data-cell-index="${focusedRow}"] [data-cell-field="${focusedField}"]`)?.focus({ preventScroll: true });
    const launchLatency = stage === 'input' ? result.effective.launchSkew : effectiveBranch.skew;
    const captureLatency = stage === 'input' ? effectiveBranch.skew : effectiveBranch.nextSkew;
    const formula = clock ? `${fmt(total.nominal)} buffer + ${fmt(path.wire)} wire + (${signed(offset)}) offset = ${fmt(latency)} ps clock latency. Relative skew: ${signed(captureLatency - launchLatency)} ps.` :
      `P${selectedRoute + 1}: cells ${fmt(total.min)} / ${fmt(total.max)} ps + wire ${fmt(path.wire * 0.55)} / ${fmt(path.wire)} ps; after OCV and noise: ${fmt(route.min)} / ${fmt(route.max)} ps. Across all routes: SETUP ${routeNames(arc.setupRoutes)} (${fmt(arc.max)} ps max), HOLD ${routeNames(arc.holdRoutes)} (${fmt(arc.min)} ps min).`;
    const affected = clock ? result.branches.filter(branch => expanded.id === 'L' || branch.id === selected).map(branch =>
      `${branch.id}1: setup ${signed(branch.first.setupSlack)}, hold ${signed(branch.first.holdSlack)} ps. ${branch.id}2: setup ${signed(branch.second.setupSlack)}, hold ${signed(branch.second.holdSlack)} ps${branch.second.provisional ? ' (provisional)' : ''}.`).join('<br>') :
      `Setup: ${fmt(current.required)} required - ${fmt(current.arrivalMax)} latest = ${signed(current.setupSlack)} ps. Hold: ${fmt(current.arrivalMin)} earliest - ${fmt(current.holdRequired)} required = ${signed(current.holdSlack)} ps.${current.provisional ? ' Upstream capture failed; downstream timing is provisional.' : ''}`;
    byId('editor-analysis').innerHTML = `${formula}<br>${affected}<br>${lastChange}`;
  }

  byId('circuit').addEventListener('dblclick', event => {
    const element = event.target.closest('[data-expand]');
    if (!element) return;
    event.preventDefault(); openFromElement(element);
  });
  byId('expand-data').addEventListener('click', () => openEditor({ kind: 'data', id: selected, stage }));
  function selectRoute(value) {
    selectedRoute = Number(value); selectedCell = 0; render();
  }
  byId('route-select').addEventListener('change', event => selectRoute(event.target.value));
  byId('editor-route-select').addEventListener('change', event => selectRoute(event.target.value));
  for (const id of ['route-summary', 'editor-route-summary']) byId(id).addEventListener('click', event => {
    const button = event.target.closest('[data-route-pick]');
    if (button) selectRoute(button.dataset.routePick);
  });
  byId('randomize-paths').addEventListener('click', () => edit(() => {
    Timing.randomizeStage(state, selected, stage); selectedCell = 0;
  }, `Randomized P1, P2, P3 on ${selected} / Stage ${stage === 'input' ? 1 : 2}`));
  byId('expand-launch').addEventListener('click', () => openEditor({ kind: 'clock', id: stage === 'input' ? 'L' : `${selected}1`, contextStage: stage }));
  byId('expand-capture').addEventListener('click', () => openEditor({ kind: 'clock', id: `${selected}${stage === 'input' ? 1 : 2}` }));
  byId('close-editor').addEventListener('click', () => byId('path-editor').close());
  byId('path-editor').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); byId('path-editor').close(); }
  });
  byId('path-editor').addEventListener('close', () => {
    clearTimeout(pendingClick);
    const button = expanded?.kind === 'clock' ? expanded.id === 'L' || (expanded.id.endsWith('1') && expanded.contextStage === 'output') ? 'expand-launch' : 'expand-capture' : 'expand-data';
    expanded = null;
    if (document.activeElement === document.body || byId('path-editor').contains(document.activeElement)) byId(button).focus({ preventScroll: true });
  });
  byId('editor-undo').addEventListener('click', () => byId('undo').click());
  byId('insert-cell').addEventListener('click', () => {
    const path = expandedPath();
    if (path.cells.length >= Timing.MAX_CELLS) return;
    const type = expanded.kind === 'clock' ? 'BUF' : byId('new-cell-type').value;
    edit(() => {
      const position = path.cells.length ? selectedCell + 1 : 0;
      path.cells.splice(position, 0, Timing.cell(type)); selectedCell = position;
    }, `Inserted ${type} / LVT / 1x`);
  });
  byId('editor-wire').addEventListener('change', event => {
    const value = Number(event.target.value);
    if (event.target.value.trim() === '' || !Number.isFinite(value)) { renderEditor(analyze(state)); return; }
    edit(() => { expandedPath().wire = Math.max(0, Math.min(600, value)); }, `${expanded.kind} wire: ${fmt(Math.max(0, Math.min(600, value)))} ps`);
  });
  byId('cell-list').addEventListener('change', event => {
    const field = event.target.dataset.cellField;
    if (!field) return;
    const index = Number(event.target.closest('[data-cell-index]').dataset.cellIndex);
    const value = field === 'size' ? Number(event.target.value) : event.target.value;
    selectedCell = index;
    edit(() => { expandedPath().cells[index][field] = value; }, `Cell U${index + 1} ${field}: ${value}`);
  });
  byId('cell-list').addEventListener('click', event => {
    const button = event.target.closest('[data-row-action]');
    if (!button || button.disabled) return;
    const index = Number(button.closest('[data-cell-index]').dataset.cellIndex);
    const action = button.dataset.rowAction;
    if (action === 'select') { selectedCell = index; renderEditor(analyze(state)); }
    else edit(() => {
      const cells = expandedPath().cells;
      if (action === 'remove') { cells.splice(index, 1); selectedCell = Math.max(0, index - 1); }
      else {
        const next = index + (action === 'up' ? -1 : 1);
        if (next >= 0 && next < cells.length) { [cells[index], cells[next]] = [cells[next], cells[index]]; selectedCell = next; }
      }
    }, `Cell U${index + 1}: ${action}`);
  });
  function selectChainCell(event) {
    const element = event.target.closest('[data-chain-cell]');
    if (!element) return;
    selectedCell = Number(element.dataset.chainCell); renderEditor(analyze(state));
    byId('cell-list').querySelector(`[data-cell-index="${selectedCell}"] select:not(:disabled)`).focus({ preventScroll: true });
    byId('cell-list').querySelector(`[data-cell-index="${selectedCell}"]`).scrollIntoView({ block: 'nearest' });
  }
  byId('expanded-chain').addEventListener('click', selectChainCell);
  byId('expanded-chain').addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectChainCell(event); }
  });

  function clockDelay(cellX, row, id, delay, trunkX, branchId, selectedStage, control) {
    const blockX = cellX + 22;
    const tapY = row + 187;
    const feed = `M ${blockX + 96} ${tapY} H ${cellX + 130} V ${row + 42} H ${cellX + 70} V ${row + 32}`;
    let route = id === 'L' ? 'M 215 64 H 25' : `M 335 64 H ${trunkX}`;
    if (id !== 'L') {
      for (let index = 0; index < state.branches.length; index++) {
        for (const crossing of [-36, 0, 36]) {
          const crossingY = 174 + index * 300 + crossing;
          if (crossingY < tapY) route += ` V ${crossingY - 6} Q ${trunkX - 11} ${crossingY} ${trunkX} ${crossingY + 6}`;
        }
      }
    }
    route += ` V ${tapY} H ${cellX + 130} V ${row + 42} H ${cellX + 70} V ${row + 32}`;
    const active = control === 'launch-skew-value' ? stage === 'input' : selected === branchId && stage === selectedStage;
    return `<path class="clock-crossing" d="${route}"/>
      <path id="clock-route-${id}" class="clock-wire" d="${route}"/>
      <path class="clock-hit" d="M ${trunkX} ${tapY} H ${cellX + 130} V ${row + 42} H ${cellX + 70} V ${row + 32}" data-expand="clock" data-path-id="${id}" data-select="${branchId}" data-stage="${selectedStage}" tabindex="0" role="button" aria-label="Expand ${id} clock path"/>
      <circle cx="${trunkX}" cy="${tapY}" r="3" fill="#347da3"/>
      <path class="clock-wire" data-clock-feed="${id}" d="${feed}"/>
      <g class="clock-delay circuit-node" data-clock-delay="${id}" data-expand="clock" data-path-id="${id}" data-select="${branchId}" data-stage="${selectedStage}" data-clock="${control}" tabindex="0" role="button" aria-label="Expand ${id} clock chain">
        <title>${id} clock latency: ${signed(delay)} ps = signed offset + clock wire + BUF chain; phase is separate</title>
        <rect class="node-body" x="${blockX}" y="${row + 170}" width="96" height="34" rx="4" fill="${active ? '#deeffa' : '#f2f8fc'}" stroke="#347da3" stroke-width="${active ? 2 : 1}"/>
        <text class="circuit-mono" x="${cellX + 70}" y="${row + 183}" text-anchor="middle" style="fill:#286487;font-size:9px">${id} / ${state.clockPaths[id].cells.length} BUF</text>
        <text class="circuit-mono" x="${cellX + 70}" y="${row + 197}" text-anchor="middle" style="fill:#286487;font-size:8px">LAT ${signed(delay)} ps</text>
      </g>`;
  }

  function renderCircuit(result) {
    const state = result.effective;
    const height = 424 + (state.branches.length - 1) * 300;
    const center = 174 + (state.branches.length - 1) * 150;
    const svg = byId('circuit');
    svg.setAttribute('viewBox', `0 0 940 ${height}`);
    const rows = state.branches.map((branch, index) => 174 + index * 300);
    let clockContent = `<g class="clock-network" aria-label="Clock source, distribution trunks and delay blocks">
      <circle cx="390" cy="64" r="3" fill="#347da3"/>
      <rect x="215" y="44" width="120" height="40" rx="4" fill="#eaf4fb" stroke="#347da3"/>
      <path d="M 224 68 h 6 v -12 h 9 v 12 h 7" fill="none" stroke="#347da3" stroke-width="1.5"/>
      <text class="circuit-mono" x="286" y="60" text-anchor="middle" style="fill:#286487">CLK ROOT</text>
      <text class="circuit-mono" x="286" y="75" text-anchor="middle" style="fill:#286487">T ${fmt(state.period)} ps</text>
      ${clockDelay(50, center, 'L', state.launchSkew, 25, selected, 'input', 'launch-skew-value')}`;
    let content = `<defs><marker id="arrow-green" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#16765b"/></marker><marker id="arrow-gray" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#99afa2"/></marker></defs>
      <text class="circuit-mono" x="95" y="27" text-anchor="middle">LAUNCH / ${state.launchEdge === 'rising' ? 'RISE' : 'FALL'}</text><text class="circuit-mono" x="470" y="27" text-anchor="middle">CAPTURE / LOCAL EDGE</text><text class="circuit-mono" x="825" y="27" text-anchor="middle">NEXT / LOCAL PHASE</text>
      <path d="M 140 ${center} H 190" stroke="#87a795" stroke-width="2" fill="none"/><circle cx="190" cy="${center}" r="4" fill="#87a795"/>
      ${node(50, center, 'FF L', `FF ${state.launchEdge === 'rising' ? 'RISE' : 'FALL'}`, `LAT ${signed(state.launchSkew)} ps`, false, false, false, null, null, null, null, state.launchEdge === 'falling')}
      <text class="circuit-mono" x="95" y="${center + 69}" text-anchor="middle">EDGE ${fmt(result.launchEdge)} ps</text>`;
    for (let index = 0; index < state.branches.length; index++) {
      const branch = state.branches[index];
      const view = result.branches[index];
      const row = rows[index];
      const inputActive = selected === branch.id && stage === 'input';
      const outputActive = selected === branch.id && stage === 'output';
      for (const [key, active, left, split, join, end, arcView] of [['input', inputActive, 241, 225, 370, 425, view.input], ['output', outputActive, 594, 565, 730, 780, view.output]]) {
        for (const [routeIndex, route] of arcView.routes.entries()) {
          const routeY = row + (routeIndex - 1) * 36;
          const setupCritical = arcView.setupRoutes.includes(route.id);
          const holdCritical = arcView.holdRoutes.includes(route.id);
          const routeActive = active && selectedRoute === routeIndex;
          const tone = setupCritical ? '#b15b35' : holdCritical ? '#167c91' : '#899d91';
          const role = `${setupCritical ? 'S' : ''}${holdCritical ? ' H' : ''}`.trim();
          const start = key === 'input' ? `M 140 ${center} H 190 V ${row}` : `M 515 ${row}`;
          const netPath = `${start} H ${split} V ${routeY} H ${join} V ${row} H ${end}`;
          const hitPath = `M ${split} ${routeY} H ${join}`;
          content += `<path id="net-${branch.id}-${key}-${routeIndex}" d="${netPath}" stroke="${tone}" stroke-width="${routeActive ? 2.8 : 1.5}" fill="none"/>
            <path class="net-hit" d="${hitPath}" data-expand="data" data-select="${branch.id}" data-stage="${key}" data-route="${routeIndex}" tabindex="0" role="button" aria-label="Expand ${branch.id} stage ${key === 'input' ? 1 : 2} route P${route.id}"/>
            <g class="circuit-node route-cell" data-expand="data" data-select="${branch.id}" data-stage="${key}" data-route="${routeIndex}" data-setup-critical="${setupCritical}" data-hold-critical="${holdCritical}" tabindex="0" role="button" aria-label="Edit ${branch.id} stage ${key === 'input' ? 1 : 2} P${route.id}: ${fmt(route.min)} min, ${fmt(route.max)} max ps${setupCritical ? ', setup critical' : ''}${holdCritical ? ', hold critical' : ''}"><title>P${route.id}: ${fmt(route.min)} ps minimum, ${fmt(route.max)} ps maximum. ${setupCritical ? 'Setup-critical route.' : ''} ${holdCritical ? 'Hold-critical route.' : ''}</title><rect x="${left}" y="${routeY - 14}" width="114" height="28" rx="3" fill="${routeActive ? '#e4f2eb' : '#ffffff'}" stroke="${routeActive ? '#16765b' : tone}" stroke-width="${routeActive ? 2 : 1}"/><text class="circuit-mono" x="${left + 57}" y="${routeY - 3}" text-anchor="middle" style="fill:${tone};font-size:9px">P${route.id} ${role}</text><text class="circuit-mono" x="${left + 57}" y="${routeY + 9}" text-anchor="middle" style="font-size:9px">${fmt(route.min)} / ${fmt(route.max)} ps</text></g>`;
        }
      }
      content += node(425, row, `${branch.kind === 'latch' ? 'L' : 'FF'} ${branch.id}1`, branch.kind === 'latch' ? `LATCH ${branch.latchLevel.toUpperCase()}` : `FF ${branch.firstEdge === 'rising' ? 'RISE' : 'FALL'}`, `LAT ${signed(branch.skew)} ps`, branch.kind === 'latch', inputActive, !view.first.valid, branch.id, 'input', view.first, branch.skew - state.launchSkew, branch.kind === 'latch' ? branch.latchLevel === 'low' : branch.firstEdge === 'falling');
      content += node(780, row, `FF ${branch.id}2`, `FF ${branch.nextEdge === 'rising' ? 'RISE' : 'FALL'}`, `LAT ${signed(branch.nextSkew)} ps`, false, outputActive, !view.valid, branch.id, 'output', view.second, branch.nextSkew - branch.skew, branch.nextEdge === 'falling');
      content += `<text class="circuit-mono" x="825" y="${row - 47}" text-anchor="middle">PHASE ${branch.nextPhase} deg</text>`;
      content += `<text class="circuit-mono" x="217" y="${row + 4}" style="fill:${branch.id === selected ? '#16765b' : '#8b9c92'};font-weight:700">${branch.id}</text>`;
      clockContent += clockDelay(425, row, `${branch.id}1`, branch.skew, 390, branch.id, 'input', 'capture-skew-value');
      clockContent += clockDelay(780, row, `${branch.id}2`, branch.nextSkew, 745, branch.id, 'output', 'capture-skew-value');
    }
    clockContent += '<g class="clock-phase"><rect x="625" y="50" width="84" height="28" rx="3" fill="#eaf4fb" stroke="#347da3"/><text class="circuit-mono" x="667" y="61" text-anchor="middle" style="fill:#286487;font-size:8px">PER BRANCH</text><text class="circuit-mono" x="667" y="73" text-anchor="middle" style="fill:#286487;font-size:8px">PHASE</text></g>';
    svg.innerHTML = content + clockContent + '</g>';
    const clockNetwork = svg.querySelector('.clock-network');
    clockNetwork.querySelectorAll('.clock-crossing').forEach(path => clockNetwork.prepend(path));
    svg.querySelectorAll('.sequential-node').forEach(element => svg.appendChild(element));
    const branch = state.branches.find(item => item.id === selected);
    const launchDelay = stage === 'input' ? state.launchSkew : branch.skew;
    const captureDelay = stage === 'input' ? branch.skew : branch.nextSkew;
    const effectiveSkew = captureDelay - launchDelay;
    const polarity = effectiveSkew > 0 ? 'POSITIVE' : effectiveSkew < 0 ? 'NEGATIVE' : 'ZERO';
    byId('relative-skew').innerHTML = `<span>${polarity} SKEW</span><strong>${signed(effectiveSkew)} ps</strong><small>${signed(captureDelay)} capture - (${signed(launchDelay)}) launch</small>`;
    byId('circuit-footer').innerHTML = `<span><b>${state.branches.length} branches / 3 routes per stage</b> / Seed: ${state.seed}</span><span>Cell setup: <b>${fmt(state.setup)} ps</b> / hold: <b>${fmt(state.hold)} ps</b> / ${branch.id}2 nominal setup: <b>${fmt(selectedResult(result).second.baseEdge / state.period)}T</b>; hold: <b>${fmt(selectedResult(result).second.baseHoldEdge / state.period)}T</b></span>`;
  }

  function renderTimeline(result) {
    const state = result.effective;
    const branch = state.branches.find(item => item.id === selected);
    const view = selectedResult(result);
    const value = checkResult(result);
    const isSetup = check === 'setup';
    const arrival = isSetup ? value.arrivalMax : value.arrivalMin;
    const required = isSetup ? value.required : value.holdRequired;
    const edge = isSetup ? value.edge : value.holdEdge;
    const slack = isSetup ? value.setupSlack : value.holdSlack;
    const isLatch = stage === 'input' && branch.kind === 'latch';
    const latchOpen = view.first[isSetup ? 'open' : 'holdOpen'];
    const latchClose = latchOpen + state.period / 2;
    const latchBaseOpen = view.first[isSetup ? 'baseOpen' : 'baseHoldOpen'];
    const launchEdge = stage === 'input' ? result.launchEdge : branch.kind === 'latch' ? latchOpen : view.first.edge;
    const lower = Math.min(-80, launchEdge - 90, edge - 130, required - 80, branch.kind === 'latch' ? branch.skew - 90 : 0);
    const upper = Math.max(state.period * (stage === 'input' ? 1.15 : 2.2), arrival + 140, edge + 150, value.edge + 150);
    const x = time => 125 + (time - lower) / (upper - lower) * 739;
    const criticalRoutes = isSetup ? view[stage].setupRoutes : view[stage].holdRoutes;
    const title = `${selected}${stage === 'input' ? 1 : 2} / ${isSetup ? 'Latest' : 'Earliest'} arrival / ${routeNames(criticalRoutes)}`;
    byId('timeline-title').textContent = title;
    byId('timeline-badge').className = `badge ${value.provisional ? 'warn' : slack < -1e-8 ? 'bad' : ''}`;
    byId('timeline-badge').textContent = value.provisional ? 'PROVISIONAL' : `${signed(slack)} ps ${slack >= -1e-8 ? 'margin' : 'violation'}`;
    let content = '';
    const tick = (upper - lower) > 2600 ? 500 : (upper - lower) > 1400 ? 250 : 200;
    for (let time = Math.ceil(lower / tick) * tick; time <= upper; time += tick) {
      content += `<line x1="${x(time)}" x2="${x(time)}" y1="28" y2="207" stroke="#e7eee9" stroke-dasharray="3 4"/><text x="${x(time)}" y="231" text-anchor="middle" class="circuit-mono">${fmt(time)}</text>`;
    }
    if (isLatch) {
      content += `<rect x="${x(latchOpen)}" y="70" width="${x(latchClose) - x(latchOpen)}" height="51" fill="#fff3cb" opacity=".8"/><text x="${(x(latchOpen) + x(latchClose)) / 2}" y="89" text-anchor="middle" class="circuit-mono" style="fill:#8c741e">TRANSPARENT</text>`;
    }
    const apertureStart = edge - state.setup - result.setupMargin;
    const apertureEnd = edge + state.hold + result.holdMargin;
    content += `<rect x="${x(apertureStart)}" y="103" width="${x(apertureEnd) - x(apertureStart)}" height="96" fill="#fae3dc" opacity=".65"/>`;
    const waveform = (rising, y, latchWave = false) => {
      let points = `M ${x(lower)} ${y}`;
      const edges = [];
      const firstCycle = Math.floor((lower - rising) / state.period) - 1;
      const lastCycle = Math.ceil((upper - rising) / state.period);
      for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
        const rise = rising + cycle * state.period;
        if (rise > lower && rise < upper) edges.push({ time: rise, level: y - 17 });
        const fall = rise + state.period / 2;
        if (fall > lower && fall < upper) edges.push({ time: fall, level: y });
      }
      const phase = ((lower - rising) % state.period + state.period) % state.period;
      points = `M ${x(lower)} ${phase < state.period / 2 ? y - 17 : y}`;
      edges.sort((left, right) => left.time - right.time).forEach(event => { points += ` H ${x(event.time)} V ${event.level}`; });
      points += ` H ${x(upper)}`;
      return `<path d="${points}" stroke="${latchWave ? '#b79225' : '#839b8b'}" stroke-width="1.6" fill="none"/>`;
    };
    content += waveform(stage === 'input' ? state.launchSkew : branch.skew, 62, stage === 'output' && branch.kind === 'latch');
    content += waveform(stage === 'input' ? branch.skew : branch.nextPhase / 360 * state.period + branch.nextSkew, 112, isLatch);
    content += `<circle data-launch-edge cx="${x(launchEdge)}" cy="54" r="4" fill="#347da3"><title>Selected launch or latch opening: ${fmt(launchEdge)} ps</title></circle>`;
    if (branch.kind === 'latch') {
      content += `<text data-latch-edge="open" x="125" y="257" class="circuit-mono">${branch.latchLevel.toUpperCase()} latch / ${check.toUpperCase()}: OPEN ${fmt(latchOpen)} ps (${fmt(latchBaseOpen / state.period)}T + latency)</text><text data-latch-edge="close" x="125" y="275" class="circuit-mono">CLOSE ${fmt(latchClose)} ps (${fmt(latchBaseOpen / state.period + 0.5)}T + latency); ${branch.latchLevel.toUpperCase()} is transparent</text>`;
    }
    content += `<text x="17" y="56" class="circuit-mono">${stage === 'output' && branch.kind === 'latch' ? 'SOURCE GATE' : 'LAUNCH CLK'}</text><text x="17" y="107" class="circuit-mono">${isLatch ? 'LATCH GATE' : 'CAPTURE CLK'}</text><text x="17" y="163" class="circuit-mono">DATA / ${isSetup ? 'MAX' : 'MIN'}</text>`;
    content += `<line x1="${x(edge)}" x2="${x(edge)}" y1="95" y2="205" stroke="#bfc9c2" stroke-dasharray="3 4"/>
      <line x1="${x(required)}" x2="${x(required)}" y1="120" y2="207" stroke="#c59740" stroke-width="1.6" stroke-dasharray="4 3"/>
      <path d="M ${x(lower)} 168 H ${x(arrival) - 6} L ${x(arrival) + 6} 150 H ${x(upper)} M ${x(lower)} 150 H ${x(arrival) - 6} L ${x(arrival) + 6} 168 H ${x(upper)}" stroke="#16765b" stroke-width="1.8" fill="none"/>
      <circle cx="${x(arrival)}" cy="159" r="5" fill="#16765b" stroke="white" stroke-width="2"/>
      <text x="${x(arrival)}" y="142" class="circuit-mono" text-anchor="middle" style="fill:#16765b">${fmt(arrival)} ps</text>
      <path d="M ${x(arrival)} 188 V 197 H ${x(required)} V 188" stroke="${color(slack)}" stroke-width="2" fill="none"/>
      <text x="${(x(arrival) + x(required)) / 2}" y="213" class="circuit-mono" text-anchor="middle" style="fill:${color(slack)}">${signed(slack)} ps</text>
      <text x="864" y="24" text-anchor="end" class="circuit-mono">${isLatch ? 'CLOSE' : 'CHECK EDGE'} ${fmt(edge)} / REQUIRED ${fmt(required)} ps</text>`;
    byId('timeline').innerHTML = content;
    byId('timeline').setAttribute('viewBox', `0 0 900 ${branch.kind === 'latch' ? 292 : 246}`);
    byId('timeline').setAttribute('aria-label', `${title}. Arrival ${fmt(arrival)} ps. Required ${fmt(required)} ps. Slack ${signed(slack)} ps.`);
    const formula = isSetup ? `${fmt(required)} required - ${fmt(arrival)} latest arrival` : `${fmt(arrival)} earliest arrival - ${fmt(required)} hold boundary`;
    byId('equation').innerHTML = `${isSetup ? 'SETUP' : 'HOLD'} SLACK = ${formula} = <strong class="${cls(slack)}">${signed(slack)} ps</strong><br>Critical ${criticalRoutes.length > 1 ? 'routes' : 'route'}: ${routeNames(criticalRoutes)}. ${isSetup ? 'max' : 'min'}(${view[stage].routes.map(route => fmt(isSetup ? route.max : route.min)).join(', ')}) = ${fmt(isSetup ? view[stage].max : view[stage].min)} ps data delay.${value.provisional ? '<br>Upstream capture failed: downstream result is conditional, not a guaranteed transfer.' : ''}`;
  }

  function renderScoreboard(result) {
    for (const [id, number] of [['worst-setup', result.worstSetup], ['worst-hold', result.worstHold]]) {
      byId(id).innerHTML = `${signed(number)}<span class="metric-unit">ps</span>`;
      byId(id).className = cls(number);
    }
    byId('checks').innerHTML = `${state.branches.length * 4 - result.violations}<span class="metric-unit">/ ${state.branches.length * 4} pass</span>`;
    byId('checks').className = result.valid ? 'good' : 'bad';
    byId('check-caption').textContent = result.valid ? 'All displayed checks pass' : `${result.violations} failing checks; downstream may be provisional`;
    byId('period-display').innerHTML = `${fmt(state.period)}<span class="metric-unit">ps</span>`;
    byId('frequency').textContent = `${fmt(1000 / state.period)} GHz / phase set per branch`;
    byId('path-table').innerHTML = result.branches.flatMap(branch => ['input', 'output'].map(key => {
      const value = key === 'input' ? branch.first : branch.second;
      const valid = value.setupSlack >= -1e-8 && value.holdSlack >= -1e-8;
      const status = value.provisional ? 'UNPROVEN' : valid ? 'PASS' : 'VIOLATION';
      return `<tr data-select="${branch.id}" data-stage="${key}" tabindex="0" role="button" aria-label="Select path ${branch.id} stage ${key === 'input' ? 1 : 2}" class="${selected === branch.id && stage === key ? 'selected' : ''}"><td>${branch.id}${key === 'input' ? 1 : 2} <span style="color:#83978a">${key === 'input' ? `L to ${branch.id}1` : `${branch.id}1 to ${branch.id}2`}</span></td><td>${key === 'input' && branch.kind === 'latch' ? 'Latch' : 'FF'}</td><td class="${cls(value.setupSlack)}">${signed(value.setupSlack)} ps<small class="critical-cell">${routeNames(branch[key].setupRoutes)}</small></td><td class="${cls(value.holdSlack)}">${signed(value.holdSlack)} ps<small class="critical-cell">${routeNames(branch[key].holdRoutes)}</small></td><td>${key === 'input' && branch.kind === 'latch' ? `${fmt(value.borrowed)} ps` : '-'}</td><td><span class="badge ${value.provisional ? 'warn' : valid ? '' : 'bad'}">${status}</span></td></tr>`;
    })).join('');
  }

  function renderExplanation(result) {
    const state = result.effective;
    const branch = state.branches.find(item => item.id === selected);
    const view = selectedResult(result);
    const value = checkResult(result);
    const arc = view[stage];
    const isLatch = stage === 'input' && branch.kind === 'latch';
    const effectiveSkew = stage === 'input' ? branch.skew - state.launchSkew : branch.nextSkew - branch.skew;
    byId('explanation-title').textContent = value.provisional ? 'A failed capture breaks the promise.' : value.setupSlack < 0 ? 'The latest data misses its deadline.' : value.holdSlack < 0 ? 'The new data arrives too soon.' : isLatch && view.first.borrowed > 0 ? 'Borrowed time is not free time.' : 'This path is inside both guardrails.';
    const setupDescription = isLatch ? `The selected next-opening setup window opens at <b>${fmt(value.open)} ps</b> and closes at <b>${fmt(value.close)} ps</b>. Its setup deadline is <b>${fmt(value.physicalRequired)} ps</b>; the borrow budget limits the effective deadline to <b>${fmt(value.required)} ps</b>.` : `Capture edge <b>${fmt(value.edge)} ps</b> minus ${fmt(state.setup)} ps setup and ${fmt(result.setupMargin)} ps margin gives a <b>${fmt(value.required)} ps</b> deadline.`;
    const debt = branch.kind === 'latch' ? `Latch ${branch.id}1 is transparent ${branch.latchLevel.toUpperCase()} and borrows <b>${fmt(view.first.borrowed)} ps</b> beyond its ${fmt(view.first.open)} ps opening. Its latest output is max(opening, arrival) + ${fmt(state.dqMax)} = <b>${fmt(view.qMax)} ps</b>. Each extra borrowed ps removes a ps from the next-stage setup budget.` : `The first capture FF relaunches on its ${branch.firstEdge} edge at ${fmt(view.first.baseEdge / state.period)}T + latency = ${fmt(view.first.edge)} ps, then adds clock-to-Q; it does not relaunch when D arrives. Moving its clock later helps first-stage setup but hurts next-stage setup.`;
    byId('explanation-content').innerHTML = `<div><h3>01 / THE SETUP CHECK</h3><p>${setupDescription} Latest arrival is <b>${fmt(value.arrivalMax)} ps</b>. Slack = required - arrival = <b class="${cls(value.setupSlack)}">${signed(value.setupSlack)} ps</b>. ${value.setupSlack < 0 ? 'Reduce the maximum data delay or find a legal clock budget.' : 'The slowest modelled data meets this budget.'}</p></div><div><h3>02 / THE HOLD CHECK</h3><p>The previous capture${isLatch ? ' / closing' : ''} edge is <b>${fmt(value.holdEdge)} ps</b>. Add ${fmt(state.hold)} ps hold and ${fmt(result.holdMargin)} ps margin: new data must not arrive before <b>${fmt(value.holdRequired)} ps</b>. Earliest arrival is <b>${fmt(value.arrivalMin)} ps</b>, leaving <b class="${cls(value.holdSlack)}">${signed(value.holdSlack)} ps</b>. Nominal hold edge ${fmt(value.baseHoldEdge / state.period)}T plus endpoint latency. Period changes move nominal edges; the effect on hold depends on the selected launch, capture and latch schedule.</p></div><div><h3>03 / THE TRADEOFF</h3><p>${debt} Selected relative skew is <b>${signed(effectiveSkew)} ps</b>. The path contributes <b>${fmt(arc.min)} / ${fmt(arc.max)} ps</b> min/max. ${value.provisional ? '<b>Upstream timing failed. These downstream numbers assume successful capture and cannot establish correctness.</b>' : 'Delay buffers protect hold but cost setup; stronger or lower-VT cells reverse that tradeoff.'}</p></div>`;
    byId('last-change').textContent = lastChange;
    byId('parallel-explanation').innerHTML = `SETUP: max(${arc.routes.map(route => fmt(route.max)).join(', ')}) = <b>${fmt(arc.max)} ps</b>, controlled by <b>${routeNames(arc.setupRoutes)}</b>.<br>HOLD: min(${arc.routes.map(route => fmt(route.min)).join(', ')}) = <b>${fmt(arc.min)} ps</b>, controlled by <b>${routeNames(arc.holdRoutes)}</b>.<br>The clocks and sequential timing are shared. Each route has its own cells and wire delay; the routes are alternatives, not delays added in series. Setup and hold can be controlled by different routes. Random routes represent independently sensitizable timing paths, not literal shorted logic outputs. Extra physical pin load from parallel paths is not modelled.`;
  }

  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function traceTable(trace, label, kind, operand = false) {
    const number = (value, withSign = false) => `<span title="${value}" data-exact="${value}">${withSign ? signed(value) : fmt(value)}</span>`;
    return `<div class="calculation-scroll" tabindex="0" role="region" aria-label="${escapeText(label)}"><table class="calculation-table" data-trace="${kind}">
      <caption>${escapeText(label)}${operand ? ' / comparison operand only' : ''}</caption>
      <thead><tr><th scope="col">Component</th><th scope="col">Expression / factors</th><th scope="col">Signed term (ps)</th><th scope="col">Running total (ps)</th></tr></thead>
      <tbody>${trace.rows.map(row => `<tr><th scope="row">${escapeText(row.component)}</th><td>${escapeText(row.expression)}</td><td>${number(row.value, true)}</td><td>${number(row.total)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th scope="row" colspan="3">${operand ? 'Operand' : 'Total'}</th><td>${number(trace.total)}</td></tr></tfoot>
    </table></div>`;
  }

  function renderCalculations(result) {
    const branch = currentBranch();
    const view = selectedResult(result);
    const value = checkResult(result);
    const input = stage === 'input';
    const setupBase = value.baseEdge;
    const holdBase = value.baseHoldEdge;
    const latency = result.effective.branches.find(item => item.id === selected)[input ? 'skew' : 'nextSkew'];
    const endpoint = `${selected}${input ? 1 : 2}`;
    byId('calculation-title').textContent = `${endpoint} / Stage ${input ? 1 : 2} component calculations`;
    byId('schedule-notes').textContent = `Selected branch ${branch.id}: source FF ${state.launchEdge} launch ${fmt(view.schedule.launch / state.period)}T; first ${branch.kind === 'latch' ? `${branch.latchLevel.toUpperCase()} latch closing` : `${branch.firstEdge} FF capture`} ${fmt(view.schedule.capture / state.period)}T, hold ${fmt(view.schedule.hold / state.period)}T${branch.kind === 'latch' ? `, opening ${fmt(view.schedule.open / state.period)}T` : ''}. Next FF ${branch.nextEdge}, waveform phase ${branch.nextPhase} deg: capture ${fmt(view.schedule.next / state.period)}T, hold ${fmt(view.schedule.nextHold / state.period)}T. These are nominal times before endpoint latency.`;
    byId('schedule-notes').textContent += ' V5 uses an explicit next-opening latch setup convention: select the first opening strictly after nominal launch, then check setup at its closing edge. This can defer setup by one period relative to ordinary latch STA. Hold edges and earliest propagation retain the original window; FF setup remains at the next active edge.';
    byId('calculation-context').innerHTML = `<p><b>${input && branch.kind === 'latch' ? `${branch.latchLevel.toUpperCase()}-level latch` : `${input ? branch.firstEdge : branch.nextEdge}-edge FF`} ${endpoint}</b> / waveform phase ${input ? 0 : branch.nextPhase} deg. Endpoint latency = signed offset + wire + clock BUF chain = <b>${signed(latency)} ps</b>.</p>
      <p data-nominal-edges>Setup edge: ${fmt(setupBase / state.period)}T (${fmt(setupBase)}) + latency (${signed(latency)}) = <b>${fmt(value.edge)} ps</b>. Hold edge: ${fmt(holdBase / state.period)}T (${fmt(holdBase)}) + latency (${signed(latency)}) = <b>${fmt(value.holdEdge)} ps</b>. Source FF nominal ${state.launchEdge} launch: ${fmt(view.schedule.launch / state.period)}T; actual launch: ${fmt(result.launchEdge)} ps. ${branch.kind === 'ff' ? `First FF nominal ${branch.firstEdge} relaunch: ${fmt(view.schedule.capture / state.period)}T.` : `Latch nominal opening: ${fmt(view.schedule.open / state.period)}T; data transfers during its ${branch.latchLevel.toUpperCase()} level.`} Phase and active edge are independent and are not added to latency or relative skew.</p>
      ${input && branch.kind === 'latch' ? `<p id="borrow-policy">Physical setup deadline = closing edge ${fmt(value.close)} - setup ${fmt(state.setup)} - uncertainty ${fmt(state.setupUncertainty)} - jitter ${fmt(state.jitter)} = <b>${fmt(value.physicalRequired)} ps</b>. Borrow-policy limit = opening ${fmt(value.open)} + allowed borrow ${fmt(value.allowedBorrow)} = <b>${fmt(value.open + value.allowedBorrow)} ps</b>. Effective required = min(physical deadline, policy limit) = <b>${fmt(value.required)} ps</b>. The restriction row below is the difference, not another physical delay.</p>` : ''}
      ${value.provisional ? '<p id="calculation-provisional" class="calculation-warning" role="status">PROVISIONAL: upstream capture failed. These Stage 2 calculations assume a successful upstream transfer; intended cycles remain fixed and missed captures are not repaired.</p>' : ''}`;
    byId('calculation-details').innerHTML = ['setup', 'hold'].map(kind => {
      const maximum = kind === 'setup';
      const bound = maximum ? 'max' : 'min';
      const trace = value.breakdown[kind];
      const arc = view[stage];
      const envelope = `${bound}(${arc.routes.map(route => `P${route.id}: ${fmt(route[bound])}`).join(', ')}) = ${fmt(arc[bound])} ps`;
      const upstream = !input && branch.kind === 'latch' ? view.first.breakdown[kind] : null;
      const opening = trace.opening;
      const comparison = opening ? `<div class="opening-comparison" data-opening="${kind}"><h4>Latch opening / separate max operand</h4><p>Upstream ${bound} arrival A = <b>${fmt(upstream.arrival.total)} ps</b>; critical route P${upstream.routeId}, all ties: <b>${routeNames(upstream.routes)}</b>. Full upstream clock, CQ, fanout and route ancestry is retained in the arrival table.</p>
        ${traceTable(opening, `${endpoint} ${kind}: latch opening clock trace`, 'opening', true)}
        <p><b>max(open ${fmt(opening.total)}, A ${fmt(upstream.arrival.total)}) = ${fmt(Math.max(opening.total, upstream.arrival.total))} ps</b>. Wait = max(0, open - A) = ${fmt(Math.max(0, opening.total - upstream.arrival.total))} ps. Q = max(open, A) + DQ ${fmt(state[maximum ? 'dqMax' : 'dqMin'])} = ${fmt(view[maximum ? 'qMax' : 'qMin'])} ps. Opening is compared, never added to A. The arrival table expresses the equivalent A + wait + DQ + downstream route.</p></div>` : '';
      return `<article class="calculation-check" data-calculation="${kind}" aria-labelledby="${kind}-calculation-title">
        <h3 id="${kind}-calculation-title">${maximum ? 'Setup / latest arrival' : 'Hold / earliest arrival'}</h3>
        <p class="critical-selection">Critical selection: <b>${envelope}</b>. Expanded route: <b>P${trace.routeId}</b>. All critical ties: <b>${routeNames(trace.routes)}</b>. Routes are alternatives, not additive. Editor selection P${selectedRoute + 1} does not override critical selection.</p>
        ${comparison}${traceTable(trace.arrival, `${endpoint} ${kind}: arrival`, 'arrival')}${traceTable(trace.required, `${endpoint} ${kind}: required boundary`, 'required')}
        <p class="calculation-slack ${cls(trace.slack)}" data-calculation-slack="${kind}">${maximum ? 'SETUP = required - arrival' : 'HOLD = arrival - required'} = ${fmt(maximum ? trace.required.total : trace.arrival.total)} - (${fmt(maximum ? trace.arrival.total : trace.required.total)}) = <strong title="${trace.slack}">${signed(trace.slack)} ps</strong>${value.provisional ? ' / PROVISIONAL' : ''}</p>
      </article>`;
    }).join('');
  }

  function renderMission(result) {
    byId('mission').hidden = mode !== 'challenge';
    if (mode !== 'challenge') return;
    const mission = missions[missionIndex - 1];
    const solved = result.valid && mission.rule(result);
    byId('mission-number').textContent = `CHALLENGE ${String(missionIndex).padStart(2, '0')} / 05`;
    byId('mission-title').textContent = mission.title;
    byId('mission-goal').textContent = mission.goal;
    byId('mission-status').textContent = solved ? 'CLOSED / All checks and mission conditions met' : result.valid ? 'Timing is clean. The mission condition is still open.' : `${result.violations} checks to close`;
    byId('moves').textContent = `${moves} ${moves === 1 ? 'move' : 'moves'} / ${completed.length} of 5 completed`;
    byId('mission').classList.toggle('solved', solved);
    byId('mission-select').value = missionIndex;
    byId('previous-mission').disabled = missionIndex === 1;
    byId('next-mission').disabled = missionIndex === 5;
    byId('hint').textContent = mission.hint;
    if (solved && !completed.includes(missionIndex)) { completed.push(missionIndex); save(); byId('moves').textContent = `${moves} moves / ${completed.length} of 5 completed`; }
  }

  function render(controls = true) {
    clearTimeout(pendingClick);
    pausePlayback();
    const result = analyze(state);
    if (controls) renderControls(result);
    renderRoutes(result);
    renderCircuit(result);
    renderTimeline(result);
    renderScoreboard(result);
    renderExplanation(result);
    renderMission(result);
    renderCalculations(result);
    rebuildPlayback();
    if (byId('path-editor').open) renderEditor(result);
    byId('undo').disabled = history.length === 0;
  }

  function startMission(index) {
    missionIndex = Math.max(1, Math.min(5, index));
    state = challenge(missionIndex);
    selected = 'A'; stage = 'input'; moves = 0; history = [];
    lastChange = 'Challenge baseline loaded. Clock period, jitter, variation and cell constraints are fixed.';
    byId('hint').hidden = true;
    byId('hint-button').textContent = 'Reveal hint';
    render();
  }

  function applyField(target) {
    if (target.disabled || target.value.trim() === '') { renderControls(analyze(state)); return; }
    const numeric = Number(target.value);
    if (!Number.isFinite(numeric)) { renderControls(analyze(state)); return; }
    const number = target.dataset.key === 'nextPhase' ? numeric : Math.max(Number(target.min), Math.min(Number(target.max), numeric));
    if (target.dataset.key === 'nextPhase' && ![0, 180].includes(number)) return;
    const branch = currentBranch();
    const object = target.dataset.scope === 'global' ? state : target.dataset.scope === 'branch' ? branch : currentPath();
    const key = target.dataset.key;
    if (object[key] === number) return;
    const fieldLabel = target.closest('.range-field').querySelector('label').textContent;
    edit(() => {
      object[key] = number;
      for (const [minKey, maxKey] of [['logicMin', 'logicMax'], ['cqMin', 'cqMax'], ['dqMin', 'dqMax']]) {
        if (key === minKey && object[minKey] > object[maxKey]) object[maxKey] = object[minKey];
        if (key === maxKey && object[maxKey] < object[minKey]) object[minKey] = object[maxKey];
      }
    }, `${fieldLabel}: ${fmt(number)}`);
  }

  let dragSnapshot = null;
  document.addEventListener('change', event => {
    const key = event.target.dataset.enum;
    if (!key || event.target.disabled || mode === 'challenge') return;
    const object = key === 'launchEdge' ? state : currentBranch();
    const value = event.target.value;
    const allowed = key === 'latchLevel' ? ['low', 'high'] : ['rising', 'falling'];
    if (!allowed.includes(value) || object[key] === value) return;
    edit(() => { object[key] = value; }, `${key === 'latchLevel' ? 'Latch active level' : key}: ${value}`);
  });
  document.addEventListener('input', event => {
    const target = event.target;
    if (!target.matches('input[type="range"][data-key]')) return;
    if (!dragSnapshot) dragSnapshot = snapshot();
    const branch = currentBranch();
    const object = target.dataset.scope === 'global' ? state : target.dataset.scope === 'branch' ? branch : currentPath();
    const key = target.dataset.key;
    object[key] = Number(target.value);
    for (const [minKey, maxKey] of [['logicMin', 'logicMax'], ['cqMin', 'cqMax'], ['dqMin', 'dqMax']]) {
      if (key === minKey && object[minKey] > object[maxKey]) object[maxKey] = object[minKey];
      if (key === maxKey && object[maxKey] < object[minKey]) object[minKey] = object[maxKey];
    }
    byId(`${target.id}-value`).value = target.value;
    render(false);
  });
  document.addEventListener('change', event => {
    const target = event.target;
    if (!target.matches('input[data-key], select[data-key]')) return;
    if (target.type === 'range' && dragSnapshot) {
      const before = checkResult(analyze(dragSnapshot.state));
      history.push(dragSnapshot); if (history.length > 80) history.shift();
      dragSnapshot = null;
      moves++;
      const after = checkResult(analyze(state));
      lastChange = `${target.closest('.range-field').querySelector('label').textContent}: ${target.value} | Setup ${signed(after.setupSlack - before.setupSlack)} ps, hold ${signed(after.holdSlack - before.holdSlack)} ps versus before.`;
      render(); save();
    } else applyField(target);
  });

  document.addEventListener('click', event => {
    clearTimeout(pendingClick);
    if (event.target.closest('#path-editor')) return;
    const element = event.target.closest('[data-select]');
    if (element) {
      const clockControl = element.dataset.clock;
      const selectPath = () => {
        selected = element.dataset.select; stage = element.dataset.stage;
        if (element.dataset.route !== undefined) selectedRoute = Number(element.dataset.route);
        render();
        if (clockControl) byId(clockControl).focus();
      };
      if (element.dataset.expand) pendingClick = setTimeout(selectPath, 600);
      else selectPath();
    }
    const kind = event.target.closest('[data-kind]');
    if (kind && !kind.disabled && currentBranch().kind !== kind.dataset.kind) edit(() => { currentBranch().kind = kind.dataset.kind; }, `Capture changed to ${kind.dataset.kind === 'latch' ? 'transparent latch' : 'flip-flop'}`);
    const tab = event.target.closest('[data-check]');
    if (tab) {
      check = tab.dataset.check;
      document.querySelectorAll('[data-check]').forEach(button => { button.classList.toggle('active', button.dataset.check === check); button.setAttribute('aria-pressed', String(button.dataset.check === check)); });
      render(false);
    }
    const modeButton = event.target.closest('[data-mode]');
    if (modeButton && modeButton.dataset.mode !== mode) {
      if (mode === 'sandbox') sandbox = clone(state);
      mode = modeButton.dataset.mode;
      document.querySelectorAll('[data-mode]').forEach(button => { button.classList.toggle('active', button.dataset.mode === mode); button.setAttribute('aria-pressed', String(button.dataset.mode === mode)); });
      if (mode === 'challenge') startMission(missionIndex);
      else { state = sandbox || defaults(); selected = 'A'; stage = 'input'; history = []; lastChange = 'Your sandbox circuit is restored.'; render(); save(); }
    }
  });
  document.addEventListener('keydown', event => {
    if (event.target.closest('#path-editor')) return;
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-select]')) {
      event.preventDefault();
      if (event.target.dataset.expand) openFromElement(event.target);
      else event.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  });
  byId('branch-select').addEventListener('change', event => { selected = event.target.value; render(); });
  byId('stage-select').addEventListener('change', event => { stage = event.target.value; render(); });
  byId('drive-size').addEventListener('change', event => edit(() => { currentPath().cells.forEach(instance => { instance.size = Number(event.target.value); }); }, `P${selectedRoute + 1} cells drive: ${event.target.value}x`));
  byId('vt').addEventListener('change', event => edit(() => { currentPath().cells.forEach(instance => { instance.vt = event.target.value; }); }, `P${selectedRoute + 1} cells VT: ${event.target.value}`));
  byId('add-buffer').addEventListener('click', () => edit(() => { if (currentPath().cells.length < Timing.MAX_CELLS) currentPath().cells.push(Timing.cell('BUF')); }, `Added LVT / 1x buffer to P${selectedRoute + 1}`));
  byId('remove-buffer').addEventListener('click', () => edit(() => {
    const cells = currentPath().cells;
    const index = cells.map(instance => instance.type).lastIndexOf('BUF');
    if (index >= 0) cells.splice(index, 1);
  }, 'Removed last data buffer'));
  byId('borrowing').addEventListener('change', event => edit(() => { state.borrowing = event.target.checked; }, `Borrowing ${event.target.checked ? 'enabled' : 'disabled'}`));
  byId('fanout').addEventListener('change', event => edit(() => {
    const count = Number(event.target.value);
    Timing.resizeFanout(state, count);
    if (!state.branches.some(branch => branch.id === selected)) selected = 'A';
  }, `Fanout changed to ${event.target.value} branches`));
  byId('undo').addEventListener('click', () => {
    const previous = history.pop();
    if (!previous) return;
    state = previous.state; moves = previous.moves; lastChange = previous.lastChange;
    if (!state.branches.some(branch => branch.id === selected)) selected = 'A';
    render(); save();
  });
  byId('reset').addEventListener('click', () => {
    if (mode === 'challenge') startMission(missionIndex);
    else edit(() => { state = defaults(); selected = 'A'; stage = 'input'; }, 'Circuit reset to default');
  });
  byId('previous-mission').addEventListener('click', () => startMission(missionIndex - 1));
  byId('next-mission').addEventListener('click', () => startMission(missionIndex + 1));
  byId('mission-select').innerHTML = missions.map((mission, index) => `<option value="${index + 1}">${index + 1}. ${mission.title}</option>`).join('');
  byId('mission-select').addEventListener('change', event => startMission(Number(event.target.value)));
  byId('hint-button').addEventListener('click', () => { byId('hint').hidden = !byId('hint').hidden; byId('hint-button').textContent = byId('hint').hidden ? 'Reveal hint' : 'Hide hint'; });

  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  const playback = { time: 0, speed: 1, playing: false, frame: null, last: null, bundle: null, dots: [], endpoints: [], period: 1 };

  function advancePlayback(now) {
    if (!playback.playing || playback.last === null) return;
    playback.time = Math.min(playback.bundle.duration, playback.time + Math.max(0, now - playback.last) * playback.period * playback.speed / 6000);
    playback.last = Math.max(playback.last, now);
  }

  function pausePlayback() {
    advancePlayback(performance.now());
    if (playback.frame !== null) cancelAnimationFrame(playback.frame);
    playback.frame = null;
    playback.playing = false;
    playback.last = null;
    if (playback.bundle) paintPlayback();
  }

  function rebuildPlayback() {
    playback.time = 0;
    playback.period = state.period;
    playback.bundle = Timing.playbackEvents(state, check);
    const svg = byId('circuit');
    const paths = new Map();
    const namespace = 'http://www.w3.org/2000/svg';
    playback.dots = playback.bundle.events.filter(event => event.enabled).map(event => {
      if (!paths.has(event.pathId)) {
        const path = byId(event.pathId);
        if (!path) throw new Error(`Missing playback path: ${event.pathId}`);
        paths.set(event.pathId, { path, length: path.getTotalLength() });
      }
      const dot = document.createElementNS(namespace, 'circle');
      const output = event.signal === 'data' && event.endpoint.endsWith('2');
      dot.setAttribute('r', event.signal === 'clock' ? '5' : '6');
      dot.setAttribute('class', `travel-token ${event.signal === 'clock' ? 'clock-token' : output ? 'output-token' : 'input-token'} ${event.transition || ''}`);
      dot.setAttribute('data-signal', event.signal);
      dot.setAttribute('data-cycle', event.cycle);
      dot.setAttribute('data-event-path', event.pathId);
      dot.setAttribute('visibility', 'hidden');
      const description = `${event.signal.toUpperCase()} C${event.cycle} ${event.endpoint}${event.transition ? ` ${event.transition}` : ` P${event.route} ${check} bound`}: departure ${fmt(event.from)} ps; arrival ${fmt(event.to)} ps`;
      const title = document.createElementNS(namespace, 'title');
      title.textContent = description;
      dot.appendChild(title);
      dot.setAttribute('aria-label', description);
      svg.appendChild(dot);
      return { event, dot, ...paths.get(event.pathId) };
    });
    playback.endpoints = [...svg.querySelectorAll('.sequential-node')].map(element => {
      const id = element.dataset.endpoint;
      const branch = state.branches.find(item => item.id === id[0]);
      const latch = id.endsWith('1') && branch.kind === 'latch';
      const transition = id === 'L' ? state.launchEdge : latch ? branch.latchLevel === 'low' ? 'rising' : 'falling' : branch[id.endsWith('1') ? 'firstEdge' : 'nextEdge'];
      const effective = playback.bundle.result.effective;
      const latency = id === 'L' ? effective.launchSkew : effective.branches.find(item => item.id === branch.id)[id.endsWith('1') ? 'skew' : 'nextSkew'];
      return { element, id, latch, level: branch?.latchLevel, latency, arrivals: playback.bundle.events.filter(event => event.signal === 'clock' && event.endpoint === id && event.transition === transition) };
    });
    playback.blocked = playback.bundle.events.filter(event => event.signal === 'data' && !event.enabled).length;
    playback.pending = playback.bundle.events.filter(event => event.enabled && event.to > playback.bundle.duration).length;
    playback.blockedEndpoints = [...new Set(playback.bundle.events.filter(event => !event.enabled).map(event => event.endpoint))].join(', ');
    byId('playback-scrub').max = playback.bundle.duration;
    paintPlayback();
  }

  function paintPlayback() {
    const { time, period, bundle } = playback;
    const echo = period * 0.08;
    const cycles = new Set();
    let clocks = 0;
    let data = 0;
    for (const item of playback.dots) {
      const progress = Timing.eventProgress(item.event, time);
      const visible = progress !== null && time <= item.event.to + echo && Number.isFinite(item.length);
      item.dot.setAttribute('visibility', visible ? 'visible' : 'hidden');
      if (!visible) continue;
      const point = item.path.getPointAtLength(Math.max(0, Math.min(item.length, item.length * progress)));
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        item.dot.setAttribute('visibility', 'hidden');
        continue;
      }
      item.dot.setAttribute('cx', point.x);
      item.dot.setAttribute('cy', point.y);
      item.dot.classList.toggle('endpoint-echo', time >= item.event.to);
      if (item.event.signal === 'clock') clocks++;
      else data++;
      cycles.add(item.event.cycle);
    }
    for (const endpoint of playback.endpoints) {
      const phase = ((time - endpoint.latency) % period + period) % period;
      const transparent = endpoint.latch && (endpoint.level === 'high' ? phase < period / 2 : phase >= period / 2);
      const capture = endpoint.arrivals.some(event => time >= event.to && time <= event.to + echo);
      endpoint.element.classList.toggle('is-transparent', transparent);
      endpoint.element.classList.toggle('capture-flash', capture);
      if (endpoint.latch) endpoint.element.setAttribute('aria-label', `${endpoint.id} ${endpoint.level.toUpperCase()}-level latch: ${transparent ? 'transparent' : 'closed'} at ${fmt(time)} ps`);
    }
    const pulseLabel = playback.playing ? '\u275a\u275a Pause' : '\u25b6 Play';
    if (byId('pulse').textContent !== pulseLabel) byId('pulse').textContent = pulseLabel;
    byId('pulse').setAttribute('aria-pressed', String(playback.playing));
    byId('pulse').disabled = motionPreference.matches;
    byId('pulse').title = motionPreference.matches ? 'Reduced motion: use step or scrub' : 'Play/Pause: 1x = six real seconds per period';
    byId('reduced-motion-note').hidden = !motionPreference.matches;
    byId('playback-time').textContent = `${fmt(time)} / ${fmt(bundle.duration)} ps`;
    byId('playback-time').title = `${time} ps elapsed; ${bundle.duration} ps = 3T; 18 real seconds at 1x`;
    byId('playback-phase').textContent = `${fmt(time / period)} / 3T | ${time === bundle.duration ? 'END' : `C${Math.floor(time / period)} / ${fmt(time % period / period * 100)}%`}`;
    byId('playback-scrub').value = time;
    byId('playback-scrub').setAttribute('aria-valuetext', `${fmt(time)} of ${fmt(bundle.duration)} picoseconds, ${fmt(time / period)} periods`);
    const cycleNames = [...cycles].sort((left, right) => left - right).map(cycle => `C${cycle}`).join(', ') || 'none';
    const status = `${playback.playing ? 'Playing' : time === bundle.duration ? 'Complete' : 'Paused'} / ${check.toUpperCase()} bounds / cycles ${cycleNames}. Visible clock ${clocks}, data ${data}. Blocked upstream: ${playback.blocked} data events${playback.blocked ? ` (${playback.blockedEndpoints}); FAILED upstream capture` : ''}. Pending arrivals beyond 3T: ${playback.pending} enabled events.`;
    if (byId('playback-status').textContent !== status) byId('playback-status').textContent = status;
  }

  function playbackFrame(now) {
    playback.frame = null;
    if (!playback.playing) return;
    advancePlayback(now);
    if (playback.time >= playback.bundle.duration) {
      playback.time = playback.bundle.duration;
      playback.playing = false;
      playback.last = null;
    }
    paintPlayback();
    if (playback.playing) playback.frame = requestAnimationFrame(playbackFrame);
  }

  byId('pulse').addEventListener('click', () => {
    if (playback.playing) { pausePlayback(); return; }
    if (motionPreference.matches || document.hidden) return;
    if (playback.time >= playback.bundle.duration) playback.time = 0;
    playback.playing = true;
    playback.last = performance.now();
    paintPlayback();
    playback.frame = requestAnimationFrame(playbackFrame);
  });
  byId('playback-restart').addEventListener('click', () => {
    pausePlayback(); playback.time = 0; paintPlayback();
  });
  byId('playback-step').addEventListener('click', () => {
    pausePlayback(); playback.time = Math.min(playback.bundle.duration, playback.time + playback.period / 20); paintPlayback();
  });
  byId('playback-scrub').addEventListener('input', event => {
    const time = Number(event.target.value);
    pausePlayback(); playback.time = Math.max(0, Math.min(playback.bundle.duration, time)); paintPlayback();
  });
  byId('playback-speed').addEventListener('change', event => {
    advancePlayback(performance.now());
    playback.speed = Number(event.target.value);
    paintPlayback();
  });
  motionPreference.addEventListener('change', () => { pausePlayback(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pausePlayback(); });
  window.addEventListener('pagehide', pausePlayback);
  window.addEventListener('beforeunload', pausePlayback);

  render();
  save();
})();