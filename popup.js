document.addEventListener('DOMContentLoaded', function () {

  initPopup();
});

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

