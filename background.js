chrome.runtime.onInstalled.addListener(() => {});

// Wildcard URL pattern → RegExp (only `*` is supported)
function patternToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

async function pickProfileForUrl(url) {
  const { qaProfiles = {}, activeRunProfile } = await chrome.storage.local.get(['qaProfiles', 'activeRunProfile']);
  for (const [id, prof] of Object.entries(qaProfiles)) {
    if (prof.urlPattern && patternToRegex(prof.urlPattern).test(url)) return id;
  }
  return activeRunProfile && qaProfiles[activeRunProfile] ? activeRunProfile : Object.keys(qaProfiles)[0] || null;
}

// Ensure there is at least one profile; create a silent "Default" if storage is empty.
async function ensureProfile() {
  const { qaProfiles = {}, activeRunProfile } = await chrome.storage.local.get(['qaProfiles', 'activeRunProfile']);
  if (Object.keys(qaProfiles).length === 0) {
    const id = 'prof_' + Date.now();
    const profiles = { [id]: { name: 'Default', fields: [] } };
    await chrome.storage.local.set({ qaProfiles: profiles, activeRunProfile: id });
    return id;
  }
  if (activeRunProfile && qaProfiles[activeRunProfile]) return activeRunProfile;
  const fallback = Object.keys(qaProfiles)[0];
  await chrome.storage.local.set({ activeRunProfile: fallback });
  return fallback;
}

function isInjectableUrl(url) {
  if (!url) return false;
  return !(url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
           url.startsWith('edge://') || url.startsWith('about:') ||
           url.startsWith('https://chrome.google.com/webstore') ||
           url.startsWith('https://chromewebstore.google.com'));
}

function sendToTab(tabId, message) {
  // Swallow the "Receiving end does not exist" rejection — happens when no content
  // script is injected (browser internal page, or page hasn't been refreshed since install).
  chrome.tabs.sendMessage(tabId, message, () => {
    // Touch lastError to suppress the "Unchecked runtime.lastError" auto-warning.
    void chrome.runtime.lastError;
  });
}

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isInjectableUrl(tab.url)) return;

  if (command === "auto-fill") {
    const profileId = await pickProfileForUrl(tab.url || '');
    if (!profileId) return;
    await chrome.storage.local.set({ activeRunProfile: profileId });
    sendToTab(tab.id, { action: "runAutoFill", profileId });
  } else if (command === "start-picker") {
    const profileId = await ensureProfile();
    sendToTab(tab.id, { action: "startPicker", profileId });
  }
});