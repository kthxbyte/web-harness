/**
 * Service worker: the only part of the extension that knows about the browser.
 *
 * Its single job is to answer "which tab is the user looking at?" and keep the daemon
 * told. That question cannot be answered from CDP: "active tab" is browser-UI state, not
 * anything the protocol exposes. The panel cannot answer it either, because a side panel
 * does not change identity when you switch tabs.
 *
 * So: the worker owns the chrome.tabs side of things, pushes the active tab to the daemon
 * whenever it changes, and lets the daemon own everything CDP.
 */

const DEFAULTS = { daemonUrl: 'http://127.0.0.1:8790', token: '' };

async function settings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

/**
 * Report the active tab to the daemon.
 *
 * We send enough identifying information for the daemon to be strict about it: the CDP
 * targetId is authoritative when present, with the URL as a fallback for matching.
 */
async function announceActiveTab(reason = 'change') {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { ok: false, error: 'no active tab' };

  // Only real web pages are controllable. chrome://, extension pages and the devtools UI
  // have no useful CDP target to drive.
  const controllable = /^https?:|^file:/.test(tab.url ?? '');
  const payload = {
    tab: {
      tabId: tab.id ?? null,
      url: tab.url ?? null,
      title: tab.title ?? null,
      windowId: tab.windowId ?? null,
      controllable,
      reason,
    },
  };

  const { daemonUrl, token } = await settings();
  if (!token) return { ok: false, error: 'no token configured — open the panel and paste one' };

  try {
    const res = await fetch(`${daemonUrl}/tab`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webh-token': token },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, status: res.status, error: body.error ?? res.statusText };
    }
    return { ok: true, tab: payload.tab };
  } catch (err) {
    // The daemon being down is an expected state, not an emergency: the panel shows it.
    return { ok: false, error: `daemon unreachable: ${err.message}` };
  }
}

// Open the panel when the toolbar button is clicked.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await announceActiveTab('installed');
});

chrome.runtime.onStartup?.addListener(() => announceActiveTab('startup'));

// The three ways the "active tab" can change.
chrome.tabs.onActivated.addListener(() => announceActiveTab('activated'));
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (changeInfo.status === 'complete' || changeInfo.url) announceActiveTab('updated');
});
chrome.tabs.onRemoved.addListener(() => announceActiveTab('removed'));
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) announceActiveTab('focus');
});

// The panel asks the worker to re-announce (e.g. right after the token is saved).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'announce') {
    announceActiveTab('panel-request').then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  if (msg?.type === 'activeTab') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
      sendResponse({ tab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null });
    });
    return true;
  }
  return false;
});
