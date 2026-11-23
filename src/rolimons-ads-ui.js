(() => {
  if (window.top !== window || document.getElementById('rta-auto-ads')) return;
  const host = document.createElement('div');
  host.id = 'rta-auto-ads';
  const root = host.attachShadow({ mode: 'open' });
  const creator = location.pathname === '/tradeadcreate';
  root.innerHTML = `
    <style>
      :host{position:fixed;right:18px;bottom:18px;z-index:2147483646;display:block;width:min(340px,calc(100vw - 36px));font:14px/1.5 system-ui,sans-serif;color:#eef3fa}
      *{box-sizing:border-box}section{background:#202831;border:1px solid #465569;border-radius:14px;box-shadow:0 8px 32px #0008;padding:16px}
      header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{font-size:16px;margin:0}p{margin:10px 0;color:#cbd6e5}label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0}
      select{font:inherit;background:#111923;color:#fff;border:1px solid #59677a;border-radius:6px;padding:6px}button,a{font:inherit;cursor:pointer;border:0;border-radius:7px;padding:9px 12px;display:inline-block;text-decoration:none;background:#2586ed;color:white}button:disabled{opacity:.5;cursor:wait}#stop{background:#455467}#toggle{background:transparent;padding:2px 6px;font-size:18px}nav{display:flex;gap:8px}#status{font-size:12px;white-space:pre-wrap}small{display:block;color:#aebed0;font-size:11px;margin-top:10px}
    </style>
    <section><header><h2>Auto trade ads</h2><button id="toggle" aria-label="Minimize auto trade ads" aria-expanded="true">−</button></header>
    <div id="body"><p>${creator ? 'Pick your offer and request above. Click once to queue it; it will post when the cooldown ends.' : 'Build an ad using Rolimon’s item picker to start auto posting.'}</p>
    ${creator ? '<label>Repeat every <select id="interval"><option value="15" selected>As soon as cooldown ends</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="120">2 hours</option></select></label>' : ''}
    <nav>${creator ? '<button id="start">Auto post this ad</button>' : '<a href="https://www.rolimons.com/tradeadcreate">Choose items</a>'}<button id="stop">Stop</button></nav>
    <p id="status" role="status" aria-live="polite">Checking schedule…</p>
    <small>Uses your signed-in account. Chrome must stay running. Changes above apply when you click Auto post this ad again.</small></div></section>`;
  document.body.append(host);
  const status = root.getElementById('status');
  let busy = false;
  let latestState;
  function render(state) {
    latestState = state;
    status.textContent = `${state.enabled ? 'Running' : 'Stopped'} · ${state.status || 'Ready when you are.'}`;
    if (state.enabled) {
      const remaining = Math.max(0, Math.ceil(((state.nextAt || 0) - Date.now()) / 1000));
      const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
      status.textContent += `\n${remaining ? `Auto posting in ${countdown}` : 'Posting when Chrome runs the scheduled task…'}`;
    }
    if (state.lastPostedAt) status.textContent += `\nLast posted: ${new Date(state.lastPostedAt).toLocaleString()}`;
  }
  async function send(type) {
    if (busy) return;
    busy = true;
    const buttons = root.querySelectorAll('nav button');
    buttons.forEach(button => { button.disabled = true; });
    if (type === 'START_ADS_FROM_PAGE') status.textContent = 'Reading your selected ad…';
    try {
      const result = await chrome.runtime.sendMessage({ type, minutes: Number(root.getElementById('interval')?.value || 15) });
      if (!result?.ok) throw new Error(result?.error || 'Reload the extension and refresh this page.');
      render(result.state);
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; buttons.forEach(button => { button.disabled = false; }); }
  }
  root.getElementById('start')?.addEventListener('click', () => send('START_ADS_FROM_PAGE'));
  root.getElementById('stop').addEventListener('click', () => send('STOP_ADS'));
  root.getElementById('toggle').addEventListener('click', event => {
    const body = root.getElementById('body');
    body.hidden = !body.hidden;
    event.target.textContent = body.hidden ? '+' : '−';
    event.target.setAttribute('aria-expanded', String(!body.hidden));
    event.target.setAttribute('aria-label', `${body.hidden ? 'Expand' : 'Minimize'} auto trade ads`);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.rolimonsTradeAds?.newValue) render(changes.rolimonsTradeAds.newValue);
  });
  setInterval(() => { if (latestState?.enabled) render(latestState); }, 1000);
  send('GET_AD_STATUS');
})();
