let profiles = {};
let activeProfileId = null;

// Load storage on page open
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['qaProfiles', 'activeRunProfile'], (result) => {
    if (result.qaProfiles && Object.keys(result.qaProfiles).length) {
      profiles = result.qaProfiles;
      renderProfileList();
      // Auto-open the active profile, or the first one as fallback.
      const initial = (result.activeRunProfile && profiles[result.activeRunProfile])
        ? result.activeRunProfile
        : Object.keys(profiles)[0];
      if (initial) openProfile(initial);
    }
  });
});

// Live-update the dashboard when the picker adds a field from the page
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.qaProfiles) return;
  profiles = changes.qaProfiles.newValue || {};
  renderProfileList();
  if (activeProfileId && profiles[activeProfileId]) {
    openProfile(activeProfileId);
  }
});

// Create new profile
document.getElementById('addProfileBtn').addEventListener('click', () => {
  const name = prompt("Enter the new test profile name (e.g. VIP Order):");
  if (name) {
    const id = 'prof_' + Date.now();
    profiles[id] = { name: name, fields: [] };
    saveDataToStorage();
    renderProfileList();
    openProfile(id);
  }
});

// Render the sidebar (profiles)
function renderProfileList() {
  const list = document.getElementById('profileList');
  list.innerHTML = '';

  Object.keys(profiles).forEach(id => {
    const div = document.createElement('div');
    div.className = `profile-item ${id === activeProfileId ? 'active' : ''}`;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = profiles[id].name;
    const count = document.createElement('span');
    count.className = 'profile-meta';
    count.textContent = `(${(profiles[id].fields || []).length})`;
    nameSpan.appendChild(count);

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-profile';
    delBtn.textContent = '×';
    delBtn.onclick = (e) => {
      e.stopPropagation();
      if (confirm(`Delete profile "${profiles[id].name}"?`)) {
        delete profiles[id];
        if (activeProfileId === id) {
          document.getElementById('editorPanel').style.display = 'none';
          document.getElementById('emptyState').style.display = 'block';
          activeProfileId = null;
        }
        saveDataToStorage();
        renderProfileList();
      }
    };

    div.append(nameSpan, delBtn);
    div.onclick = () => openProfile(id);
    list.appendChild(div);
  });
}

// Open a profile for editing
function openProfile(id) {
  activeProfileId = id;
  renderProfileList(); // refresh highlight

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('editorPanel').style.display = 'block';
  document.getElementById('currentProfileName').textContent = profiles[id].name;
  document.getElementById('urlPatternInput').value = profiles[id].urlPattern || '';

  const container = document.getElementById('fieldsContainer');
  container.innerHTML = '';

  // Group fields by the page they were captured on, in capture order. Fields without
  // pageKey metadata (legacy entries) go into an "Uncategorized" group at the top.
  const fields = profiles[id].fields || [];
  const groups = [];
  let currentGroup = null;
  fields.forEach(field => {
    const key = field.pageKey || '__legacy';
    if (!currentGroup || currentGroup.key !== key) {
      currentGroup = {
        key,
        title: field.pageTitle || (key === '__legacy' ? 'Uncategorized' : 'Untitled page'),
        fields: []
      };
      groups.push(currentGroup);
    }
    currentGroup.fields.push(field);
  });

  groups.forEach(group => {
    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = `<div class="section-title"></div><div class="section-key"></div>`;
    header.querySelector('.section-title').textContent = group.title;
    header.querySelector('.section-key').textContent = group.key === '__legacy' ? '' : group.key;
    container.appendChild(header);

    const sectionBox = document.createElement('div');
    sectionBox.className = 'section-fields';
    group.fields.forEach(field => addFieldRowToUI(field, sectionBox));
    container.appendChild(sectionBox);
  });
}

document.getElementById('addFieldBtn').addEventListener('click', () => {
  // Append to the last section, or to the container directly if no section exists yet.
  const sections = document.querySelectorAll('.section-fields');
  const target = sections.length ? sections[sections.length - 1] : document.getElementById('fieldsContainer');
  addFieldRowToUI({ selector: '', value: '', note: '' }, target);
});

function addFieldRowToUI(field, target) {
  const row = document.createElement('div');
  row.className = 'field-row';
  // Preserve grouping metadata across edit/save cycles.
  row.dataset.pageKey = field.pageKey || '';
  row.dataset.pageTitle = field.pageTitle || '';

  const selGroup = buildFieldGroup('CSS Selector', 'sel-input', "e.g. #firstName", field.selector || '');
  const valGroup = buildFieldGroup('Value', 'val-input', 'e.g. John or {{RANDOM_EMAIL}}', field.value || '');
  const noteGroup = buildFieldGroup('Note (optional)', 'note-input', 'e.g. First name field', field.note || '');

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-field';
  removeBtn.textContent = 'Delete';
  removeBtn.onclick = () => row.remove();

  row.append(selGroup, valGroup, noteGroup, removeBtn);
  (target || document.getElementById('fieldsContainer')).appendChild(row);
}

function buildFieldGroup(labelText, inputClass, placeholder, value) {
  const group = document.createElement('div');
  group.className = 'field-group';

  const label = document.createElement('label');
  label.textContent = labelText;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = inputClass;
  input.placeholder = placeholder;
  input.value = value;

  group.append(label, input);
  return group;
}

// Save data
document.getElementById('saveBtn').addEventListener('click', () => {
  if (!activeProfileId) return;
  
  const rows = document.querySelectorAll('.field-row');
  const newFields = [];
  
  rows.forEach(row => {
    const sel = row.querySelector('.sel-input').value.trim();
    const val = row.querySelector('.val-input').value.trim();
    const note = row.querySelector('.note-input').value.trim();
    if (sel) {
      const field = { selector: sel, value: val };
      if (note) field.note = note;
      if (row.dataset.pageKey) field.pageKey = row.dataset.pageKey;
      if (row.dataset.pageTitle) field.pageTitle = row.dataset.pageTitle;
      newFields.push(field);
    }
  });

  profiles[activeProfileId].fields = newFields;
  profiles[activeProfileId].urlPattern = document.getElementById('urlPatternInput').value.trim();
  saveDataToStorage();
  renderProfileList();
  
  const btn = document.getElementById('saveBtn');
  btn.innerText = "Saved";
  setTimeout(() => { btn.innerText = "Save"; }, 1500);
});

function saveDataToStorage() {
  chrome.storage.local.set({ qaProfiles: profiles });
}

// --- Export / Import ---

document.getElementById('exportBtn').addEventListener('click', () => {
  const data = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), profiles }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `autofill-pro-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      const imported = parsed.profiles || parsed;
      if (typeof imported !== 'object' || Array.isArray(imported)) throw new Error('format');
      const merge = confirm('OK: Merge with existing profiles.\nCancel: Replace everything.');
      profiles = merge ? { ...profiles, ...imported } : imported;
      saveDataToStorage();
      renderProfileList();
      alert(`Import complete: ${Object.keys(imported).length} profile(s).`);
    } catch (err) {
      alert('Invalid JSON file.');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
});