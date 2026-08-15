const FAST_PATH_TTL = 24 * 60 * 1000;      // 快路径窗口：1 小时
const PROBE_TIMEOUT_MS = 3000;             // 后台探测超时
const PROBE_POLL_INTERVAL_MS = 200;        // 轮询 chrome.storage 的间隔
const PROBE_INITIAL_DELAY_MS = 300;        // 给探测标签页留出加载时间

// 【调试用】取消下面这行注释，可清除接管状态，用于测试「未接管 → 跳转引导页」流程
// chrome.storage.local.remove(['isNewtabActive', 'lastActivated']);

document.addEventListener('DOMContentLoaded', function () {

  const storage = chrome?.storage?.local;

  // storage 不可用时（权限未生效 / 旧安装未重载 / 浏览器差异），
  // 跳过 newtab 接管检测，保证 popup 核心功能（标签信息 + 操作按钮）仍可用
  if (!storage || typeof storage.get !== 'function') {
    initPopup();
    return;
  }

  storage.get(['isNewtabActive', 'lastActivated'], (data) => {
    const lastActivated = data.lastActivated || 0;
    const recentlyActive =
      !!data.isNewtabActive &&
      Date.now() - lastActivated < FAST_PATH_TTL;

    // 快路径：1 小时内确认接管，直接渲染
    if (recentlyActive) {
      initPopup();
      return;
    }

    // 慢路径：popup 先渲染保证交互，同时后台探测当前 newtab 接管者
    initPopup();
    probeNewtab(lastActivated).then((isOurs) => {
      if (isOurs) {
        // main.tsx 已在探测页内刷新过 lastActivated，无需再写
        return;
      }
      const enableUrl = chrome.i18n.getMessage('enable_ihomepage_url');
      // 曾经接管过但已过期 → 找回接管页；从未接管过 → 首次引导页
      const expired = lastActivated > 0;
      chrome.tabs.create({
        url: expired
          ? enableUrl.replace('/enable-ihomepage/', '/restore-new-tab/')
          : enableUrl,
      });
      window.close();
    });
  });
});

// 后台开一个不带 url 的新标签页（浏览器会用当前配置的 newtab 打开）。
// 若该页是 Hexpane，main.tsx 会写入新的 lastActivated；据此判断接管者。
function probeNewtab(baselineTs) {
  return new Promise((resolve) => {
    chrome.tabs.create({ active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(false);
        return;
      }
      const tabId = tab.id;
      const cleanup = () => {
        chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
      };

      const start = Date.now();
      const poll = () => {
        chrome.storage.local.get(['lastActivated'], (after) => {
          if ((after.lastActivated || 0) > baselineTs) {
            cleanup();
            resolve(true);
            return;
          }
          if (Date.now() - start > PROBE_TIMEOUT_MS) {
            cleanup();
            resolve(false);
            return;
          }
          setTimeout(poll, PROBE_POLL_INTERVAL_MS);
        });
      };
      setTimeout(poll, PROBE_INITIAL_DELAY_MS);
    });
  });
}

function initPopup() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const tab = tabs[0];
    if (tab) {

      // Set title and URL
      document.getElementById('title').textContent = tab.title;
      document.getElementById('url').textContent = tab.url;

      let icon = tab.favIconUrl || '';

      // Set apple-touch-icon
      chrome.scripting?.executeScript(
        {
          target: { tabId: tab.id },
          func: getAppleTouchIcon,
        },
        (results) => {
          if (results && results[0]) {
            icon = results[0];
          }
        }
      );

      // Set favicon
      document.getElementById('favicon').src = icon;

      // Add event
      document.getElementById('logo').onclick = () => {
        chrome.tabs.create({
          // url: 'chrome-extension://dckiemmhjfdcojbcailnjdninceldhmn/index.html'
          url: chrome.i18n.getMessage('extension_start_page_url'),
        });
      }

      const addToMyWebsiteButton = document.getElementById('add-to-my-website');
      addToMyWebsiteButton.innerHTML = chrome.i18n.getMessage('add_to_my_websites');
      addToMyWebsiteButton.onclick = () => {
        chrome.tabs.create({
          url: `${chrome.i18n.getMessage('extension_add_to_my_websie_url')}#/?message=${encodeURI(
            JSON.stringify({
              type: 'ADD_TO_MY_WEBSITE',
              data: {
                favIconUrl: icon,
                title: tab.title,
                url: tab.url,
              },
            }),
          )}`,
        });
      }

      const addToReadingList = document.getElementById('add-to-reading-list');
      addToReadingList.innerHTML = chrome.i18n.getMessage('add_to_reading_list');
      addToReadingList.onclick = () => {
        chrome.tabs.create({
          url: `${chrome.i18n.getMessage('extension_add_to_reading_list_url')}#/?message=${encodeURI(
            JSON.stringify({
              type: 'ADD_TO_READING_LIST',
              data: {
                favIconUrl: icon,
                title: tab.title,
                url: tab.url,
              },
            }),
          )}`,
        });
      }

    }
  });
}

function getAppleTouchIcon() {
  const link = document.querySelector("link[rel='apple-touch-icon']");
  return link ? link.href : '';
}

