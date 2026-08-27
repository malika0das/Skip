var toggle  = document.getElementById('enabledToggle');
var buttons = document.querySelectorAll('.skip-btn');

chrome.storage.sync.get({ skipSec: 5, enabled: true }, function(cfg) {
  toggle.checked = cfg.enabled !== false;
  buttons.forEach(function(b) {
    b.classList.toggle('active', +b.dataset.sec === (cfg.skipSec || 5));
  });
});

toggle.addEventListener('change', function() {
  chrome.storage.sync.set({ enabled: toggle.checked });
});

buttons.forEach(function(btn) {
  btn.addEventListener('click', function() {
    buttons.forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    chrome.storage.sync.set({ skipSec: +btn.dataset.sec });
  });
});
