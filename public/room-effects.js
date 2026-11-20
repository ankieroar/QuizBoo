// Each note is [frequency, start in seconds, duration in seconds, optional waveform].
const cues = {
  click: [[550, 0, .055]],
  correct: [[523, 0, .13], [659, .09, .17]],
  wrong: [[330, 0, .17], [220, .13, .24]],
  celebrate: [[659, 0, .12], [784, .09, .14], [1047, .19, .3]],
  victory: [
    [392, 0, .19], [523, .16, .19], [659, .32, .2], [784, .48, .28],
    [1047, .72, .35], [659, .72, .36], [523, .72, .40], [126, .73, .14, 'triangle'],
    [880, 1.13, .18], [988, 1.29, .18], [1175, 1.46, .27], [587, 1.46, .29],
    [1047, 1.78, .18], [1175, 1.94, .20], [1319, 2.14, .82],
    [1047, 2.14, .80], [784, 2.14, .78], [523, 2.14, .75], [130, 2.15, .17, 'triangle'],
    [1568, 2.42, .48], [2093, 2.63, .40]
  ],
  defeat: [[440, 0, .18], [349, .16, .18], [262, .32, .3]]
};

export function setupSounds(button) {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return {play() {}, stop() {}};
  let enabled = localStorage.getItem('quizboo-sound') !== 'off';
  let context, output, activeResult = [];

  function updateButton() {
    button.textContent = enabled ? '🔊 Âm thanh' : '🔇 Âm thanh';
    button.setAttribute('aria-pressed', String(enabled));
  }

  function unlock() {
    if (!enabled) return Promise.resolve();
    try {
      if (!context) {
        context = new Audio();
        output = context.createGain();
        output.connect(context.destination);
      }
      return context.state === 'running' ? Promise.resolve() : context.resume().catch(()=>{});
    } catch {
      return Promise.resolve();
    }
  }

  function stop() {
    for (const note of activeResult) note.stop();
    activeResult = [];
  }

  function play(...names) {
    if (!enabled || context?.state !== 'running') return;
    const click = names[0] === 'click';
    if (!click) stop();
    let start = context.currentTime + .01;
    for (const name of names) {
      let end = start;
      for (const [frequency, offset, duration, wave] of cues[name]) {
        const time = start + offset;
        const oscillator = context.createOscillator();
        const envelope = context.createGain();
        oscillator.type = wave || (name === 'wrong' ? 'triangle' : 'sine');
        oscillator.frequency.value = frequency;
        envelope.gain.setValueAtTime(.001, time);
        envelope.gain.exponentialRampToValueAtTime(click || name === 'victory' ? .065 : .12, time + .014);
        envelope.gain.exponentialRampToValueAtTime(.001, time + duration);
        oscillator.connect(envelope);
        envelope.connect(output);
        oscillator.start(time);
        oscillator.stop(time + duration);
        oscillator.onended = () => {
          oscillator.disconnect();
          envelope.disconnect();
          activeResult = activeResult.filter(note=>note!==oscillator);
        };
        if (!click) activeResult.push(oscillator);
        end = Math.max(end, time + duration);
      }
      start = end + .06;
    }
  }

  button.hidden = false;
  updateButton();
  button.onclick = () => {
    enabled = !enabled;
    localStorage.setItem('quizboo-sound', enabled ? 'on' : 'off');
    if (output) output.gain.value = enabled ? 1 : 0;
    updateButton();
    if (enabled) unlock().then(()=>play('click'));
    else stop();
  };
  document.addEventListener('click', event => {
    const control = event.target.closest('button, a[href]');
    if (control && control !== button && enabled) unlock().then(()=>play('click'));
  }, {capture:true});
  document.addEventListener('submit', unlock, {capture:true});
  return {play, stop};
}

export function setupStageZoom(viewport, stage) {
  let gesture;
  const distance = touches => Math.hypot(touches[0].clientX-touches[1].clientX, touches[0].clientY-touches[1].clientY);

  function reset() {
    gesture = null;
    stage.classList.remove('is-pinching');
    stage.style.removeProperty('--stage-scale');
  }

  viewport.addEventListener('touchstart', event => {
    if (event.touches.length !== 2) {
      if (gesture) reset();
      return;
    }
    const first = event.touches[0], second = event.touches[1];
    const rect = viewport.getBoundingClientRect();
    gesture = {distance: Math.max(distance(event.touches), 1)};
    stage.style.transformOrigin = `${(first.clientX+second.clientX)/2-rect.left}px ${(first.clientY+second.clientY)/2-rect.top}px`;
    stage.classList.add('is-pinching');
    if (event.cancelable) event.preventDefault();
  }, {passive:false});
  viewport.addEventListener('touchmove', event => {
    if (!gesture || event.touches.length !== 2) return;
    const scale = Math.min(1.85, Math.max(.82, distance(event.touches)/gesture.distance));
    stage.style.setProperty('--stage-scale', String(scale));
    if (event.cancelable) event.preventDefault();
  }, {passive:false});
  viewport.addEventListener('touchend', event => {
    if (event.touches.length < 2) reset();
  }, {passive:true});
  viewport.addEventListener('touchcancel', reset, {passive:true});
  return reset;
}
