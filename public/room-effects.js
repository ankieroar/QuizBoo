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

function mediaSoundOutput() {
  const audio=new Audio();
  const cueUrl=names=>new URL(`./sounds/${names.join('-') || 'unlock'}.mp3`,import.meta.url).href;
  let ready=false, result=false;

  audio.preload='auto';
  audio.src=cueUrl([]);
  audio.hidden=true;
  document.body.append(audio);
  let attempt=0;
  async function start(names) {
    const click=names[0]==='click';
    if (click && result && !audio.paused) return true;
    const current=++attempt;
    result=names.length>0 && !click;
    try {
      const url=cueUrl(names);
      if (audio.src!==url) audio.src=url;
      else if (audio.readyState>0) audio.currentTime=0;
      await audio.play();
      if (attempt===current) ready=true;
    } catch {
      if (attempt===current) ready=false;
    }
    return ready;
  }
  return {start, get ready() { return ready; }, stop() { attempt++; audio.pause(); }};
}

export function setupSounds(button) {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!button || (!Audio && typeof window.Audio!=='function')) return {play() {}, stop() {}};
  let enabled = true;
  try { enabled = localStorage.getItem('quizboo-sound') !== 'off'; } catch {}
  let context, output, activeResult = [];
  let fallback=Audio ? null : mediaSoundOutput();
  let mediaUnlock;

  function isRunning() {
    return fallback ? fallback.ready : context?.state==='running';
  }

  function updateButton() {
    const running=enabled && isRunning();
    button.textContent = running ? '🔊 Âm thanh' : mediaUnlock && enabled ? 'Đang bật âm thanh…' : '🔇 Bật âm thanh';
    button.setAttribute('aria-pressed', String(running));
  }

  function unlock(gesture = false) {
    if (fallback) {
      if (!enabled || !gesture || fallback.ready) return Promise.resolve(enabled && fallback.ready);
      if (!mediaUnlock) {
        mediaUnlock=fallback.start([]).finally(()=>{mediaUnlock=null;updateButton();});
        updateButton();
      }
      return mediaUnlock;
    }
    if (!enabled || (!context && !gesture)) return Promise.resolve(false);
    try {
      if (gesture && context?.state==='interrupted') {
        stop();
        context.close().catch(()=>{});
        context=null;
      }
      if (gesture && context?.state==='closed') context=null;
      if (!context) {
        context = new Audio();
        output = context.createGain();
        output.connect(context.destination);
        context.onstatechange=updateButton;
        // Start a silent buffer inside the gesture as well as requesting resume.
        const primer=context.createBufferSource();
        primer.buffer=context.createBuffer(1,1,context.sampleRate);
        primer.connect(output);
        primer.onended=()=>primer.disconnect();
        primer.start();
      }
      if (context.state==='running') {
        updateButton();
        return Promise.resolve(true);
      }
      return context.resume().then(()=>{
        updateButton();
        return context.state==='running';
      }).catch(()=>false);
    } catch {
      if (gesture && !context && typeof window.Audio==='function') {
        fallback=mediaSoundOutput();
        return unlock(true);
      }
      updateButton();
      return Promise.resolve(false);
    }
  }

  function stop() {
    fallback?.stop();
    for (const note of activeResult) {
      try { note.stop(); } catch {}
    }
    activeResult = [];
  }

  function playNotes(names) {
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
        envelope.gain.exponentialRampToValueAtTime(click ? .09 : name==='victory' ? .065 : .12, time + .014);
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

  function play(...names) {
    if (!enabled) return;
    if (fallback) {
      if (fallback.ready) fallback.start(names).then(updateButton);
      return;
    }
    if (context?.state==='running') playNotes(names);
    else if (context) {
      const requested=performance.now();
      unlock().then(ready=>{
        if (ready && !document.hidden && performance.now()-requested<1500) playNotes(names);
      });
    }
  }

  button.hidden = false;
  updateButton();
  button.onclick = () => {
    enabled = !(enabled && isRunning());
    try { localStorage.setItem('quizboo-sound',enabled?'on':'off'); } catch {}
    if (output) output.gain.value = enabled ? 1 : 0;
    updateButton();
    if (enabled) unlock(true).then(ready=>{ if (ready) play('click'); });
    else stop();
  };
  function unlockFromGesture(event) {
    if (event.isTrusted && !button.contains(event.target)) unlock(true);
  }
  document.addEventListener('pointerup',unlockFromGesture,{capture:true,passive:true});
  document.addEventListener('touchend',unlockFromGesture,{capture:true,passive:true});
  document.addEventListener('keydown',unlockFromGesture,{capture:true});
  document.addEventListener('click', event => {
    const control = event.target.closest?.('button, a[href]');
    if (event.isTrusted && control && control!==button && enabled) unlock(true).then(ready=>{
      if (ready) play('click');
    });
  }, {capture:true});
  document.addEventListener('submit',unlockFromGesture,{capture:true});
  document.addEventListener('visibilitychange',()=>{
    if (document.hidden) stop();
    else unlock();
  });
  window.addEventListener('pageshow',()=>unlock());
  return {play, stop};
}

export function setupStageZoom(viewport, stage, controls) {
  if (!viewport || !stage) return ()=>{};
  const min=.8, max=1.8;
  let scale=1, gesture=null, frame=0;
  const clamp=value=>Math.max(min,Math.min(max,value));
  const distance=(a,b)=>Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
  const resetButton=controls?.querySelector('[data-zoom="reset"]');
  const zoomOut=controls?.querySelector('[data-zoom="out"]');
  const zoomIn=controls?.querySelector('[data-zoom="in"]');

  function applyZoom(value) {
    scale=clamp(Math.round(value*100)/100);
    stage.style.setProperty('--stage-scale',String(scale));
    viewport.classList.toggle('is-zoomed',scale>1);
    if (resetButton) {
      resetButton.textContent=`${Math.round(scale*100)}%`;
      zoomOut.disabled=scale<=min;
      zoomIn.disabled=scale>=max;
    }
    if (scale<=1) { viewport.scrollTop=0; viewport.scrollLeft=0; }
  }

  function finishGesture() {
    if (!gesture) return;
    gesture=null;
    cancelAnimationFrame(frame);
    frame=0;
    stage.classList.remove('is-pinching');
    stage.style.transformOrigin='';
    applyZoom(scale);
  }

  function reset() {
    finishGesture();
    applyZoom(1);
  }

  function startGesture(type,x,y) {
    const rect=viewport.getBoundingClientRect();
    gesture={type,zoom:scale};
    if (!Number.isFinite(x)) x=rect.left+rect.width/2;
    if (!Number.isFinite(y)) y=rect.top+rect.height/2;
    stage.style.transformOrigin=`${x-rect.left+viewport.scrollLeft}px ${y-rect.top+viewport.scrollTop}px`;
    stage.classList.add('is-pinching');
  }

  function preview(value) {
    cancelAnimationFrame(frame);
    frame=requestAnimationFrame(()=>{
      if (gesture) stage.style.setProperty('--stage-scale',String(clamp(value)));
    });
  }

  if (controls) {
    zoomOut.onclick=()=>{finishGesture();applyZoom(scale-.2);};
    zoomIn.onclick=()=>{finishGesture();applyZoom(scale+.2);};
    resetButton.onclick=reset;
  }

  viewport.addEventListener('touchstart', event => {
    if (event.touches.length!==2) {
      if (gesture?.type==='touch') finishGesture();
      return;
    }
    const first = event.touches[0], second = event.touches[1];
    startGesture('touch',(first.clientX+second.clientX)/2,(first.clientY+second.clientY)/2);
    gesture.distance=Math.max(distance(first,second),1);
    if (event.cancelable) event.preventDefault();
  }, {passive:false});
  viewport.addEventListener('touchmove', event => {
    if (gesture?.type!=='touch' || event.touches.length!==2) return;
    if (event.cancelable) event.preventDefault();
    preview(gesture.zoom*distance(event.touches[0],event.touches[1])/gesture.distance);
  }, {passive:false});
  viewport.addEventListener('touchend', event => {
    if (gesture?.type==='touch' && event.touches.length<2) finishGesture();
  }, {passive:true});
  viewport.addEventListener('touchcancel', finishGesture, {passive:true});

  // WebKit can deliver native gesture events instead of a complete touch sequence.
  viewport.addEventListener('gesturestart',event=>{
    if (event.cancelable) event.preventDefault();
    if (!gesture) startGesture('webkit',event.clientX,event.clientY);
  },{passive:false});
  viewport.addEventListener('gesturechange',event=>{
    if (event.cancelable) event.preventDefault();
    if (gesture?.type==='webkit' && Number.isFinite(event.scale)) preview(gesture.zoom*event.scale);
  },{passive:false});
  viewport.addEventListener('gestureend',()=>{
    if (gesture?.type==='webkit') finishGesture();
  });
  window.addEventListener('blur',finishGesture);
  document.addEventListener('visibilitychange',()=>{ if (document.hidden) finishGesture(); });
  return reset;
}
