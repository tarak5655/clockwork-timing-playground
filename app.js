(function () {
  'use strict';
  const { defaults, analyze, clone, challenge } = Timing;
  const byId = id => document.getElementById(id);
  const fmt = value => Math.abs(value) < 0.05 ? '0' : Number(value.toFixed(1)).toString();
  const signed = value => `${value >= -1e-8 ? '+' : ''}${fmt(value)}`;
  const color = value => value >= -1e-8 ? '#16765b' : '#b83f3d';
  const cls = value => value >= -1e-8 ? 'good' : 'bad';
  const storageKey = 'clockwork-v1';
  let state = defaults();
  let selected = 'A';
  let stage = 'input';
  let check = 'setup';
  let mode = 'sandbox';
  let missionIndex = 1;
  let moves = 0;
  let history = [];
  let completed = [];
  let sandbox = null;
  let lastChange = 'Baseline: LVT, 1x drive. Select a path to inspect its timing budget.';
  let storageAvailable = true;
  const missions = [
    { title: 'Beat the setup deadline', goal: 'Close every timing check. Path A is too slow. Keep the 1,000 ps clock and the original timing margins.', hint: 'A larger drive strength reduces cell delay. Watch the minimum arrival too: every speedup spends hold margin.', rule: () => true },
    { title: 'Fast is not always good', goal: 'Close every timing check and insert at least one delay buffer on A / Stage 1. The new data is racing past the hold boundary.', hint: 'Five delay buffers on A / Stage 1 add 120 ps to its minimum delay. There is ample setup headroom.', rule: () => state.branches[0].input.buffers > 0 },
    { title: 'Skew has a price', goal: 'Close every timing check with A capture skew at +40 ps or later. The following half-cycle path must pass too.', hint: 'Positive capture skew helps A1 but takes time from A2. Try +60 ps and a 3x drive on A / Stage 2.', rule: () => state.branches[0].skew >= 40 },
    { title: 'Borrow, then pay it back', goal: 'Enable borrowing and close every check while latch A borrows at least 100 ps. The next FF must still capture on time.', hint: 'A arrives after its latch opens. Enable borrowing and allow at least 260 ps. The borrowed time is already propagated into A2.', rule: result => state.borrowing && result.branches[0].first.borrowed >= 100 },
    { title: 'Close the noisy corner', goal: 'Close every check with 45 ps noise, 35 ps relative setup jitter, and 10% early/late variation. Protect the slow and fast paths together.', hint: 'Try 2x drive on A / Stage 1 and B / Stage 2, then add four buffers on B / Stage 1. The noise envelope hurts setup and hold in different ways.', rule: () => true }
  ];

  function validSaved(value) {
    if (!value || !Array.isArray(value.branches) || value.branches.length < 2 || value.branches.length > 4) return false;
    const base = defaults();
    for (const key of Object.keys(base)) {
      if (typeof base[key] === 'number' && (!Number.isFinite(value[key]) || Math.abs(value[key]) > 10000)) return false;
    }
    if (value.period < 600 || value.period > 2400 || typeof value.borrowing !== 'boolean') return false;
    if (value.cqMin < 0 || value.cqMin > value.cqMax || value.dqMin < 0 || value.dqMin > value.dqMax) return false;
    return value.branches.every((branch, index) => {
      if (branch.id !== 'ABCD'[index] || !['ff', 'latch'].includes(branch.kind)) return false;
      if (![branch.skew, branch.nextSkew].every(number => Number.isFinite(number) && Math.abs(number) <= 200)) return false;
      return ['input', 'output'].every(key => {
        const arc = branch[key];
        return arc && Object.hasOwn(Timing.VT, arc.vt) && [0.5, 1, 1.5, 2, 3, 4].includes(arc.size) &&
          Number.isInteger(arc.buffers) && arc.buffers >= 0 && arc.buffers <= 12 &&
          [arc.logicMax, arc.logicMin, arc.wire].every(number => Number.isFinite(number) && number >= 0 && number <= 1600) && arc.logicMin <= arc.logicMax;
      });
    });
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
    const arc = branch[stage];
    const view = selectedResult(result);
    const locked = mode === 'challenge';
    byId('selected-title').textContent = `Path ${selected} / Stage ${stage === 'input' ? 1 : 2}`;
    byId('selected-tag').textContent = `${selected}${stage === 'input' ? 1 : 2}`;
    byId('branch-select').innerHTML = state.branches.map(item => `<option ${item.id === selected ? 'selected' : ''}>${item.id}</option>`).join('');
    byId('stage-select').value = stage;
    byId('element-name').textContent = stage === 'input' ? `${branch.kind === 'latch' ? 'LATCH' : 'FF'} ${selected}1` : `FF ${selected}2 / 180 deg`;
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
      range('launch-skew', `Launch clock delay / ${sourceName}`, stage === 'input' ? state.launchSkew : branch.skew,
        stage === 'input' ? -120 : -200, stage === 'input' ? 120 : 200, 5,
        stage === 'input' ? 'global' : 'branch', stage === 'input' ? 'launchSkew' : 'skew', 'ps', locked && stage === 'input') +
      range('capture-skew', `Capture clock delay / ${captureName}`, branch[skewKey], -200, 200, 5, 'branch', skewKey);
    byId('path-controls').innerHTML =
      range('logic-max', 'Base logic delay / max', arc.logicMax, 0, 1600, 5, 'path', 'logicMax') +
      range('logic-min', 'Base logic delay / min', arc.logicMin, 0, 800, 1, 'path', 'logicMin') +
      range('wire-delay', 'Net delay / max', arc.wire, 0, 600, 5, 'path', 'wire');
    byId('buffer-count').textContent = arc.buffers;
    byId('remove-buffer').disabled = arc.buffers === 0;
    byId('add-buffer').disabled = arc.buffers === 12;
    byId('drive-size').value = arc.size;
    byId('vt').value = arc.vt;
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

  function node(x, y, id, label, sublabel, latch, active, failed, branchId, selectedStage, timingValue, relativeSkew) {
    const stroke = active ? '#16765b' : failed ? '#bf7770' : '#c4d2ca';
    const fill = latch ? '#fff7dd' : active ? '#e7f4ec' : '#ffffff';
    return `<g class="circuit-node" ${branchId ? `data-select="${branchId}" data-stage="${selectedStage}" tabindex="0" role="button" aria-label="Select ${id}"` : ''}>
      <rect class="node-body" x="${x}" y="${y - 32}" width="90" height="64" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="${active ? 2 : 1.5}"/>
      <text class="circuit-text circuit-title" x="${x + 45}" y="${y - 7}" text-anchor="middle">${id}</text>
      <text class="circuit-mono" x="${x + 45}" y="${y + 11}" text-anchor="middle">${label}</text>
      <text class="circuit-mono" x="${x + 45}" y="${y + 51}" text-anchor="middle">${sublabel}</text>
      <circle class="clock-pin" cx="${x + 70}" cy="${y - 32}" r="2.5" fill="#347da3"/>
      ${latch ? `<text class="circuit-mono" x="${x + 70}" y="${y - 20}" text-anchor="middle" style="fill:#347da3;font-size:8px">G</text><path d="M ${x + 20} ${y + 24} h 12 v -6 h 12 v 6 h 12" fill="none" stroke="#b08b29"/>` : `<path d="M ${x + 63} ${y - 32} l 7 9 l 7 -9" fill="none" stroke="#347da3"/>`}
      ${failed ? `<circle cx="${x + 83}" cy="${y - 26}" r="4" fill="#b83f3d"/>` : ''}
      ${timingValue ? `<g class="capture-timing" data-timing="${branchId}${selectedStage === 'input' ? 1 : 2}">
        <text class="circuit-mono" x="${x + 45}" y="${y + 67}" text-anchor="middle">SKEW ${signed(relativeSkew)} ps</text>
        <text class="circuit-mono" data-slack="setup" x="${x + 45}" y="${y + 84}" text-anchor="middle" style="fill:${color(timingValue.setupSlack)}">Setup slack ${signed(timingValue.setupSlack)} ps</text>
        <text class="circuit-mono" data-slack="hold" x="${x + 45}" y="${y + 100}" text-anchor="middle" style="fill:${color(timingValue.holdSlack)}">Hold slack ${signed(timingValue.holdSlack)} ps</text>
        ${timingValue.provisional ? `<text class="circuit-mono" x="${x + 45}" y="${y + 115}" text-anchor="middle" style="fill:#80620f">PROVISIONAL</text>` : ''}
      </g>` : ''}</g>`;
  }

  function clockDelay(cellX, row, id, delay, trunkX, branchId, selectedStage, control) {
    const blockX = cellX + 22;
    const tapY = row - 68;
    const active = control === 'launch-skew-value' ? stage === 'input' : selected === branchId && stage === selectedStage;
    return `<path class="clock-wire" d="M ${trunkX} ${tapY} H ${blockX}"/>
      <circle cx="${trunkX}" cy="${tapY}" r="3" fill="#347da3"/>
      <path class="clock-wire" data-clock-feed="${id}" d="M ${cellX + 70} ${row - 51} V ${row - 32}"/>
      <g class="clock-delay circuit-node" data-clock-delay="${id}" data-select="${branchId}" data-stage="${selectedStage}" data-clock="${control}" tabindex="0" role="button" aria-label="Edit ${id} clock delay">
        <title>${id} clock delay: ${signed(delay)} ps offset from its nominal phase</title>
        <rect class="node-body" x="${blockX}" y="${row - 85}" width="96" height="34" rx="4" fill="${active ? '#deeffa' : '#f2f8fc'}" stroke="#347da3" stroke-width="${active ? 2 : 1}"/>
        <text class="circuit-mono" x="${cellX + 70}" y="${row - 72}" text-anchor="middle" style="fill:#286487;font-size:9px">CLK ${id} DELAY</text>
        <text class="circuit-mono" x="${cellX + 70}" y="${row - 58}" text-anchor="middle" style="fill:#286487">${signed(delay)} ps</text>
      </g>`;
  }

  function renderCircuit(result) {
    const height = state.branches.length * 210 + 110;
    const center = (height - 40) / 2 + 12;
    const svg = byId('circuit');
    svg.setAttribute('viewBox', `0 0 920 ${height}`);
    const rows = state.branches.map((branch, index) => 174 + index * 210);
    const lastTap = rows[rows.length - 1] - 68;
    const clockTrunk = trunkX => {
      let route = `M ${trunkX} 64`;
      for (const row of rows) {
        if (row >= lastTap) break;
        route += ` V ${row - 6} Q ${trunkX - 11} ${row} ${trunkX} ${row + 6}`;
      }
      return `<path class="clock-crossing" d="${route} V ${lastTap}"/><path class="clock-wire" d="${route} V ${lastTap}"/>`;
    };
    let clockContent = `<g class="clock-network" aria-label="Clock source, distribution trunks and delay blocks">
      <path class="clock-wire" d="M 215 64 H 25 V ${center - 68} M 335 64 H 625 M 709 64 H 745"/>
      ${clockTrunk(390)}${clockTrunk(745)}
      <circle cx="390" cy="64" r="3" fill="#347da3"/>
      <rect x="215" y="44" width="120" height="40" rx="4" fill="#eaf4fb" stroke="#347da3"/>
      <path d="M 224 68 h 6 v -12 h 9 v 12 h 7" fill="none" stroke="#347da3" stroke-width="1.5"/>
      <text class="circuit-mono" x="286" y="60" text-anchor="middle" style="fill:#286487">CLK ROOT</text>
      <text class="circuit-mono" x="286" y="75" text-anchor="middle" style="fill:#286487">T ${fmt(state.period)} ps</text>
      <rect x="625" y="50" width="84" height="28" rx="3" fill="#eaf4fb" stroke="#347da3"/>
      <text class="circuit-mono" x="667" y="68" text-anchor="middle" style="fill:#286487">PHASE 180 deg</text>
      ${clockDelay(50, center, 'L', state.launchSkew, 25, selected, 'input', 'launch-skew-value')}`;
    let content = `<defs><marker id="arrow-green" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#16765b"/></marker><marker id="arrow-gray" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#99afa2"/></marker></defs>
      <text class="circuit-mono" x="95" y="27" text-anchor="middle">LAUNCH / 0 deg</text><text class="circuit-mono" x="470" y="27" text-anchor="middle">CAPTURE / 0 deg</text><text class="circuit-mono" x="825" y="27" text-anchor="middle">NEXT / 180 deg</text>
      <path d="M 140 ${center} H 190" stroke="#87a795" stroke-width="2" fill="none"/><circle cx="190" cy="${center}" r="4" fill="#87a795"/>
      ${node(50, center, 'FF L', 'LAUNCH', `CLK ${signed(state.launchSkew)} ps`, false, false, false)}`;
    for (let index = 0; index < state.branches.length; index++) {
      const branch = state.branches[index];
      const view = result.branches[index];
      const row = rows[index];
      const inputActive = selected === branch.id && stage === 'input';
      const outputActive = selected === branch.id && stage === 'output';
      const inputPath = `M 190 ${center} V ${row} H 425`;
      const outputPath = `M 515 ${row} H 780`;
      for (const [key, active, netPath, left, arcView] of [['input', inputActive, inputPath, 255, view.input], ['output', outputActive, outputPath, 610, view.output]]) {
        content += `<path id="net-${branch.id}-${key}" d="${netPath}" stroke="${active ? '#16765b' : '#9aae9f'}" stroke-width="${active ? 2.8 : 1.7}" fill="none" marker-end="url(#arrow-${active ? 'green' : 'gray'})"/>
          <path class="net-hit" d="${netPath}" data-select="${branch.id}" data-stage="${key}" tabindex="0" role="button" aria-label="Select path ${branch.id} stage ${key === 'input' ? 1 : 2}"/>
          <g class="circuit-node" data-select="${branch.id}" data-stage="${key}" tabindex="0" role="button" aria-label="Edit logic ${branch.id} stage ${key === 'input' ? 1 : 2}"><rect x="${left}" y="${row - 15}" width="99" height="30" rx="4" fill="${active ? '#e4f1e9' : '#f1f5f2'}" stroke="${active ? '#16765b' : '#c7d4ca'}"/><text class="circuit-mono" x="${left + 49.5}" y="${row + 4}" text-anchor="middle" style="fill:${active ? '#16765b' : '#657d6c'}">${fmt(arcView.max)} ps</text></g>
          <text class="circuit-mono" x="${left + 49.5}" y="${row - 25}" text-anchor="middle">${branch[key].vt} / ${branch[key].size}x</text>
          <text class="circuit-mono" x="${left + 49.5}" y="${row + 36}" text-anchor="middle">${branch[key].buffers ? `${branch[key].buffers} BUF + ` : ''}${fmt(branch[key].wire)} ps NET</text>`;
        if (branch[key].buffers) content += `<path d="M ${left + 108} ${row - 7} l 12 7 l -12 7 z" fill="white" stroke="${active ? '#16765b' : '#9aae9f'}"/>`;
      }
      content += node(425, row, `${branch.kind === 'latch' ? 'L' : 'FF'} ${branch.id}1`, branch.kind === 'latch' ? 'LATCH' : 'CAPTURE', `CLK ${signed(branch.skew)} ps`, branch.kind === 'latch', inputActive, !view.first.valid, branch.id, 'input', view.first, branch.skew - state.launchSkew);
      content += node(780, row, `FF ${branch.id}2`, 'NEXT STAGE', `CLK ${signed(branch.nextSkew)} ps`, false, outputActive, !view.valid, branch.id, 'output', view.second, branch.nextSkew - branch.skew);
      content += `<text class="circuit-mono" x="217" y="${row + 4}" style="fill:${branch.id === selected ? '#16765b' : '#8b9c92'};font-weight:700">${branch.id}</text>`;
      clockContent += clockDelay(425, row, `${branch.id}1`, branch.skew, 390, branch.id, 'input', 'capture-skew-value');
      clockContent += clockDelay(780, row, `${branch.id}2`, branch.nextSkew, 745, branch.id, 'output', 'capture-skew-value');
    }
    svg.innerHTML = content + clockContent + '</g>';
    const branch = currentBranch();
    const launchDelay = stage === 'input' ? state.launchSkew : branch.skew;
    const captureDelay = stage === 'input' ? branch.skew : branch.nextSkew;
    const effectiveSkew = captureDelay - launchDelay;
    const polarity = effectiveSkew > 0 ? 'POSITIVE' : effectiveSkew < 0 ? 'NEGATIVE' : 'ZERO';
    byId('relative-skew').innerHTML = `<span>${polarity} SKEW</span><strong>${signed(effectiveSkew)} ps</strong><small>${signed(captureDelay)} capture - (${signed(launchDelay)}) launch</small>`;
    byId('circuit-footer').innerHTML = `<span><b>${state.branches.length} branches</b> / Launch load: ${fmt(result.fanoutMin)} min, ${fmt(result.fanoutMax)} max ps</span><span>Cell setup: <b>${fmt(state.setup)} ps</b> / hold: <b>${fmt(state.hold)} ps</b> / Next capture: <b>1.5T</b></span>`;
  }

  function renderTimeline(result) {
    const branch = currentBranch();
    const view = selectedResult(result);
    const value = checkResult(result);
    const isSetup = check === 'setup';
    const arrival = isSetup ? value.arrivalMax : value.arrivalMin;
    const required = isSetup ? value.required : value.holdRequired;
    const edge = isSetup ? value.edge : value.holdEdge;
    const slack = isSetup ? value.setupSlack : value.holdSlack;
    const isLatch = stage === 'input' && branch.kind === 'latch';
    const launchEdge = stage === 'input' ? state.launchSkew : branch.kind === 'latch' ? view.first.open : view.first.edge;
    const lower = Math.min(-80, launchEdge - 90, edge - 130, required - 80);
    const upper = Math.max(state.period * (stage === 'input' ? 1.15 : 1.7), arrival + 140, edge + 150);
    const x = time => 125 + (time - lower) / (upper - lower) * 739;
    const title = `${selected}${stage === 'input' ? 1 : 2} / ${isSetup ? 'Latest data arrival' : 'Earliest new data'}`;
    byId('timeline-title').textContent = title;
    byId('timeline-badge').className = `badge ${value.provisional ? 'warn' : slack < -1e-8 ? 'bad' : ''}`;
    byId('timeline-badge').textContent = value.provisional ? 'PROVISIONAL' : `${signed(slack)} ps ${slack >= -1e-8 ? 'margin' : 'violation'}`;
    let content = '';
    const tick = (upper - lower) > 2600 ? 500 : (upper - lower) > 1400 ? 250 : 200;
    for (let time = Math.ceil(lower / tick) * tick; time <= upper; time += tick) {
      content += `<line x1="${x(time)}" x2="${x(time)}" y1="28" y2="207" stroke="#e7eee9" stroke-dasharray="3 4"/><text x="${x(time)}" y="231" text-anchor="middle" class="circuit-mono">${fmt(time)}</text>`;
    }
    if (isLatch) {
      content += `<rect x="${x(view.first.open)}" y="70" width="${x(view.first.close) - x(view.first.open)}" height="51" fill="#fff3cb" opacity=".8"/><text x="${(x(view.first.open) + x(view.first.close)) / 2}" y="89" text-anchor="middle" class="circuit-mono" style="fill:#8c741e">TRANSPARENT</text>`;
    }
    const apertureStart = edge - state.setup - result.setupMargin;
    const apertureEnd = edge + state.hold + result.holdMargin;
    content += `<rect x="${x(apertureStart)}" y="103" width="${x(apertureEnd) - x(apertureStart)}" height="96" fill="#fae3dc" opacity=".65"/>`;
    const waveform = (rising, y, latchWave = false) => {
      let points = `M ${x(lower)} ${y}`;
      const edges = [];
      for (let cycle = -4; cycle <= 8; cycle++) {
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
    content += waveform(launchEdge, 62, stage === 'output' && branch.kind === 'latch');
    content += waveform(isLatch ? view.first.open : value.edge, 112, isLatch);
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
    byId('timeline').setAttribute('aria-label', `${title}. Arrival ${fmt(arrival)} ps. Required ${fmt(required)} ps. Slack ${signed(slack)} ps.`);
    const formula = isSetup ? `${fmt(required)} required - ${fmt(arrival)} latest arrival` : `${fmt(arrival)} earliest arrival - ${fmt(required)} hold boundary`;
    byId('equation').innerHTML = `${isSetup ? 'SETUP' : 'HOLD'} SLACK = ${formula} = <strong class="${cls(slack)}">${signed(slack)} ps</strong>${value.provisional ? '<br>Upstream capture failed: downstream result is conditional, not a guaranteed transfer.' : ''}`;
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
    byId('frequency').textContent = `${fmt(1000 / state.period)} GHz / next clock at 180 deg`;
    byId('path-table').innerHTML = result.branches.flatMap(branch => ['input', 'output'].map(key => {
      const value = key === 'input' ? branch.first : branch.second;
      const valid = value.setupSlack >= -1e-8 && value.holdSlack >= -1e-8;
      const status = value.provisional ? 'UNPROVEN' : valid ? 'PASS' : 'VIOLATION';
      return `<tr data-select="${branch.id}" data-stage="${key}" tabindex="0" role="button" aria-label="Select path ${branch.id} stage ${key === 'input' ? 1 : 2}" class="${selected === branch.id && stage === key ? 'selected' : ''}"><td>${branch.id}${key === 'input' ? 1 : 2} <span style="color:#83978a">${key === 'input' ? `L to ${branch.id}1` : `${branch.id}1 to ${branch.id}2`}</span></td><td>${key === 'input' && branch.kind === 'latch' ? 'Latch' : 'FF'}</td><td class="${cls(value.setupSlack)}">${signed(value.setupSlack)} ps</td><td class="${cls(value.holdSlack)}">${signed(value.holdSlack)} ps</td><td>${key === 'input' && branch.kind === 'latch' ? `${fmt(value.borrowed)} ps` : '-'}</td><td><span class="badge ${value.provisional ? 'warn' : valid ? '' : 'bad'}">${status}</span></td></tr>`;
    })).join('');
  }

  function renderExplanation(result) {
    const branch = currentBranch();
    const view = selectedResult(result);
    const value = checkResult(result);
    const arc = view[stage];
    const isLatch = stage === 'input' && branch.kind === 'latch';
    const effectiveSkew = stage === 'input' ? branch.skew - state.launchSkew : branch.nextSkew - branch.skew;
    byId('explanation-title').textContent = value.provisional ? 'A failed capture breaks the promise.' : value.setupSlack < 0 ? 'The latest data misses its deadline.' : value.holdSlack < 0 ? 'The new data arrives too soon.' : isLatch && view.first.borrowed > 0 ? 'Borrowed time is not free time.' : 'This path is inside both guardrails.';
    const setupDescription = isLatch ? `The latch opens at <b>${fmt(value.open)} ps</b> and closes at <b>${fmt(value.close)} ps</b>. Its physical setup deadline is <b>${fmt(value.physicalRequired)} ps</b>; the borrow budget limits the effective deadline to <b>${fmt(value.required)} ps</b>.` : `Capture edge <b>${fmt(value.edge)} ps</b> minus ${fmt(state.setup)} ps setup and ${fmt(result.setupMargin)} ps margin gives a <b>${fmt(value.required)} ps</b> deadline.`;
    const debt = branch.kind === 'latch' ? `Latch ${branch.id}1 borrows <b>${fmt(view.first.borrowed)} ps</b> beyond its ${fmt(view.first.open)} ps opening. Its latest output is max(opening, arrival) + ${fmt(state.dqMax)} = <b>${fmt(view.qMax)} ps</b>. Each extra borrowed ps removes a ps from the next-stage setup budget.` : `The first capture FF relaunches at T + latency + clock-to-Q, not immediately when D arrives. Moving its clock later helps first-stage setup but hurts next-stage setup.`;
    byId('explanation-content').innerHTML = `<div><h3>01 / THE SETUP CHECK</h3><p>${setupDescription} Latest arrival is <b>${fmt(value.arrivalMax)} ps</b>. Slack = required - arrival = <b class="${cls(value.setupSlack)}">${signed(value.setupSlack)} ps</b>. ${value.setupSlack < 0 ? 'Reduce the maximum data delay or find a legal clock budget.' : 'The slowest modelled data meets this budget.'}</p></div><div><h3>02 / THE HOLD CHECK</h3><p>The previous capture${isLatch ? ' / closing' : ''} edge is <b>${fmt(value.holdEdge)} ps</b>. Add ${fmt(state.hold)} ps hold and ${fmt(result.holdMargin)} ps margin: new data must not arrive before <b>${fmt(value.holdRequired)} ps</b>. Earliest arrival is <b>${fmt(value.arrivalMin)} ps</b>, leaving <b class="${cls(value.holdSlack)}">${signed(value.holdSlack)} ps</b>. ${stage === 'input' ? 'Increasing the period does not repair this first-stage hold check.' : 'This half-cycle check uses the previous edge of the phase-shifted next clock.'}</p></div><div><h3>03 / THE TRADEOFF</h3><p>${debt} Selected relative skew is <b>${signed(effectiveSkew)} ps</b>. The path contributes <b>${fmt(arc.min)} / ${fmt(arc.max)} ps</b> min/max. ${value.provisional ? '<b>Upstream timing failed. These downstream numbers assume successful capture and cannot establish correctness.</b>' : 'Delay buffers protect hold but cost setup; stronger or lower-VT cells reverse that tradeoff.'}</p></div>`;
    byId('last-change').textContent = lastChange;
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
    const result = analyze(state);
    if (controls) renderControls(result);
    renderCircuit(result);
    renderTimeline(result);
    renderScoreboard(result);
    renderExplanation(result);
    renderMission(result);
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
    const number = Math.max(Number(target.min), Math.min(Number(target.max), numeric));
    const branch = currentBranch();
    const object = target.dataset.scope === 'global' ? state : target.dataset.scope === 'branch' ? branch : branch[stage];
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
  document.addEventListener('input', event => {
    const target = event.target;
    if (!target.matches('input[type="range"][data-key]')) return;
    if (!dragSnapshot) dragSnapshot = snapshot();
    const branch = currentBranch();
    const object = target.dataset.scope === 'global' ? state : target.dataset.scope === 'branch' ? branch : branch[stage];
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
    if (!target.matches('input[data-key]')) return;
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
    const element = event.target.closest('[data-select]');
    if (element) {
      const clockControl = element.dataset.clock;
      selected = element.dataset.select; stage = element.dataset.stage; render();
      if (clockControl) byId(clockControl).focus();
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
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-select]')) {
      event.preventDefault();
      event.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  });
  byId('branch-select').addEventListener('change', event => { selected = event.target.value; render(); });
  byId('stage-select').addEventListener('change', event => { stage = event.target.value; render(); });
  byId('drive-size').addEventListener('change', event => edit(() => { currentBranch()[stage].size = Number(event.target.value); }, `Drive size: ${event.target.value}x`));
  byId('vt').addEventListener('change', event => edit(() => { currentBranch()[stage].vt = event.target.value; }, `VT flavor: ${event.target.value}`));
  byId('add-buffer').addEventListener('click', () => edit(() => { currentBranch()[stage].buffers = Math.min(12, currentBranch()[stage].buffers + 1); }, 'Added one delay buffer'));
  byId('remove-buffer').addEventListener('click', () => edit(() => { currentBranch()[stage].buffers = Math.max(0, currentBranch()[stage].buffers - 1); }, 'Removed one delay buffer'));
  byId('borrowing').addEventListener('change', event => edit(() => { state.borrowing = event.target.checked; }, `Borrowing ${event.target.checked ? 'enabled' : 'disabled'}`));
  byId('fanout').addEventListener('change', event => edit(() => {
    const count = Number(event.target.value);
    while (state.branches.length < count) {
      const branch = clone(defaults().branches[0]); branch.id = 'ABCD'[state.branches.length]; state.branches.push(branch);
    }
    state.branches = state.branches.slice(0, count);
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

  byId('pulse').addEventListener('click', () => {
    const result = analyze(state);
    const svg = byId('circuit');
    svg.querySelectorAll('.pulse-dot').forEach(dot => dot.remove());
    const scale = 2300 / (2 * state.period);
    const start = performance.now();
    const dots = result.branches.flatMap(view => ['input', 'output'].map(key => {
      const net = byId(`net-${view.id}-${key}`);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '5'); dot.setAttribute('class', 'pulse-dot');
      dot.setAttribute('visibility', 'hidden');
      svg.appendChild(dot);
      return { dot, net, length: net.getTotalLength(), from: key === 'input' ? result.launchMax : view.qMax,
        to: key === 'input' ? view.first.arrivalMax : view.second.arrivalMax, enabled: key === 'input' || view.first.valid };
    }));
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    function animate(now) {
      let running = false;
      const time = (now - start) / scale + Math.min(0, result.launchMax);
      for (const item of dots) {
        if (!item.dot.isConnected || !item.enabled) continue;
        const progress = reduced ? 1 : Math.max(0, Math.min(1, (time - item.from) / Math.max(1, item.to - item.from)));
        if (time >= item.from || reduced) {
          const point = item.net.getPointAtLength(item.length * progress);
          item.dot.setAttribute('cx', point.x); item.dot.setAttribute('cy', point.y);
          item.dot.setAttribute('visibility', 'visible');
        }
        if (progress < 1) running = true;
      }
      if (running) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
    lastChange = 'Latest-data pulse launched. A first-stage timing failure stops its downstream pulse; travel time and latch waiting use the modelled arrivals.';
    renderExplanation(result);
  });

  render();
  save();
})();