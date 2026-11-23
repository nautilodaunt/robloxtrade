const api = document.getElementById('api');
const page = document.getElementById('page');
const details = document.getElementById('details');
document.getElementById('version').textContent = chrome.runtime.getManifest().version;
async function check(force = false) {
  api.textContent = "Checking Rolimon's API…";
  page.textContent = 'Checking Roblox trade page…';
  details.textContent = '';
  const granted = await chrome.permissions.contains({ origins: ['https://api.rolimons.com/*', 'https://trades.roblox.com/*'] });
  document.getElementById('grant').hidden = granted;
  await Promise.all([
    (async () => {
      try {
        const result = await chrome.runtime.sendMessage({ type: 'GET_ROLIMONS_VALUES', force });
        api.textContent = result?.ok
          ? `API working: ${Object.keys(result.items).length.toLocaleString()} items${result.stale ? ' (cached; latest fetch failed)' : ''}.`
          : `API failed: ${result?.error || 'No response from background worker'}`;
      } catch (error) { api.textContent = `Background worker error: ${error.message}`; }
    })(),
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TRADE_STATUS' });
        page.textContent = `Page script ${result.version}: ${result.sides} trade sections detected, ${result.rows} value rows; ${result.listRows || 0} list entries, ${result.summaries || 0} comparisons (${result.category || "unknown"}).`;
        details.textContent = result.listError || (result.sides
          ? result.messages.join('\n')
          : 'Open a trade so its items are visible. If they already are, the page layout needs a selector fix.');
      } catch {
        page.textContent = 'Page script is not responding.';
        details.textContent = 'Switch to your Roblox trade tab, refresh it, then open this popup again. After code updates, reload the extension at chrome://extensions first.';
      }
    })()
  ]);
}
document.getElementById('retry').addEventListener('click', () => check(true));
check();

document.getElementById('grant').addEventListener('click', async () => {
  try {
    await chrome.permissions.request({ origins: ['https://api.rolimons.com/*', 'https://trades.roblox.com/*'] });
    await check();
  } catch (error) { details.textContent = error.message; }
});

const adStatus = document.getElementById('ad-status');
async function updateAds(type = 'GET_AD_STATUS') {
  try {
    const result = await chrome.runtime.sendMessage({ type });
    if (!result?.ok) throw new Error(result?.error || 'Reload the extension.');
    const state = result.state;
    adStatus.textContent = `${state.enabled ? 'Running' : 'Stopped'} — ${state.status || 'Choose your items on Rolimon’s to begin.'}`;
    if (state.enabled && state.nextAt) adStatus.textContent += `\nNext attempt: ${new Date(state.nextAt).toLocaleString()}`;
  } catch (error) { adStatus.textContent = error.message; }
}
document.getElementById('ad-stop').addEventListener('click', () => updateAds('STOP_ADS'));
updateAds();
