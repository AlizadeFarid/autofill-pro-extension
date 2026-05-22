document.addEventListener('DOMContentLoaded', async () => {
  const select = document.getElementById('profileSelect');
  select.innerHTML = '';

  let { qaProfiles = {}, activeRunProfile } = await chrome.storage.local.get(['qaProfiles', 'activeRunProfile']);

  // First-run: silently create a Default profile so the user never sees a dead state.
  if (Object.keys(qaProfiles).length === 0) {
    const id = 'prof_' + Date.now();
    qaProfiles = { [id]: { name: 'Default', fields: [] } };
    activeRunProfile = id;
    await chrome.storage.local.set({ qaProfiles, activeRunProfile });
  }

  Object.keys(qaProfiles).forEach(id => {
    const option = document.createElement('option');
    option.value = id;
    option.text = qaProfiles[id].name;
    select.appendChild(option);
  });

  if (activeRunProfile && qaProfiles[activeRunProfile]) {
    select.value = activeRunProfile;
  } else {
    chrome.storage.local.set({ activeRunProfile: select.value });
  }

  select.addEventListener('change', (e) => {
    chrome.storage.local.set({ activeRunProfile: e.target.value });
  });

  // Settings toggles
  const { settings = {} } = await chrome.storage.local.get(['settings']);
  document.getElementById('autoFillOnLoad').checked = !!settings.autoFillOnLoad;
  document.getElementById('clickButtons').checked = !!settings.clickButtons;

  const persistSetting = async (key, val) => {
    const cur = (await chrome.storage.local.get(['settings'])).settings || {};
    cur[key] = val;
    await chrome.storage.local.set({ settings: cur });
  };
  document.getElementById('autoFillOnLoad').addEventListener('change', e => persistSetting('autoFillOnLoad', e.target.checked));
  document.getElementById('clickButtons').addEventListener('change', e => persistSetting('clickButtons', e.target.checked));
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('clearBtn').addEventListener('click', async () => {
  const { qaProfiles = {}, activeRunProfile } = await chrome.storage.local.get(['qaProfiles', 'activeRunProfile']);
  if (!activeRunProfile || !qaProfiles[activeRunProfile]) return;
  const name = qaProfiles[activeRunProfile].name;
  const count = (qaProfiles[activeRunProfile].fields || []).length;
  if (!confirm(`Delete all ${count} saved fields in profile "${name}"?`)) return;
  qaProfiles[activeRunProfile].fields = [];
  await chrome.storage.local.set({ qaProfiles });
  const btn = document.getElementById('clearBtn');
  btn.textContent = 'Cleared';
  setTimeout(() => { btn.textContent = 'Clear saved fields'; }, 1500);
});

document.getElementById('pickBtn').addEventListener('click', async () => {
  const profileId = document.getElementById('profileSelect').value;
  if (!profileId) { alert("Please select a profile!"); return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
    alert("AutoFill Pro can't run on this page (browser internal page). Open a regular website tab.");
    return;
  }
  chrome.tabs.sendMessage(tab.id, { action: "startPicker", profileId: profileId }, () => {
    if (chrome.runtime.lastError) {
      alert("Couldn't reach the page — refresh it (F5) and try again.");
    } else {
      window.close();
    }
  });
});