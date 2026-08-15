chrome.contextMenus.onClicked.addListener(genericOnClick);

function genericOnClick(info, tab) {
  switch (info.menuItemId) {
    case 'page-add-to-my-websites':
      chrome.tabs.create({
        url: `chrome://newtab/#/?message=${encodeURI(
          JSON.stringify({
            type: 'ADD_TO_MY_WEBSITE',
            data: {
              favIconUrl: tab.favIconUrl,
              title: tab.title,
              url: tab.url,
            },
          }),
        )}`,
      });

      break;
    case 'link-add-to-my-websites':
      chrome.tabs.create({
        url: `chrome://newtab/#/?message=${encodeURI(
          JSON.stringify({
            type: 'ADD_TO_MY_WEBSITE',
            data: {
              title: info.selectionText,
              url: info.linkUrl,
            },
          }),
        )}`,
      });
      break;
    case 'page-add-to-reading-list':
      chrome.tabs.create({
        url: `chrome://newtab/#/?message=${encodeURI(
          JSON.stringify({
            type: 'ADD_TO_READING_LIST',
            data: {
              favIconUrl: tab.favIconUrl,
              title: tab.title,
              url: tab.url,
            },
          }),
        )}`,
      });

      break;
    case 'link-add-to-reading-list':
      chrome.tabs.create({
        url: `chrome://newtab/#/?message=${encodeURI(
          JSON.stringify({
            type: 'ADD_TO_READING_LIST',
            data: {
              title: info.selectionText,
              url: info.linkUrl,
            },
          }),
        )}`,
      });
      break;
    /*
    case 'image-add-to-photos':
      chrome.tabs.create({
        url: `chrome://newtab/#/?message=${encodeURI(
          JSON.stringify({
            type: 'ADD_TO_MY_PHOTOS',
            data: {
              srcUrl: info.srcUrl,
            },
          }),
        )}`,
      });
      break;
    case 'image-add-to-selection':
      chrome.tabs.create({
        url: `chrome://newtab/#/?message=${encodeURI(
          JSON.stringify({
            type: 'ADD_TO_MY_SELECTION',
            data: {
              pageUrl: info.pageUrl,
              selectionText: info.selectionText,
            },
          }),
        )}`,
      });
      break;
    */

    default:
      // Standard context menu item function
      console.log('Standard context menu item clicked.');
  }
}

chrome.runtime.onInstalled.addListener(details => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      title: chrome.i18n.getMessage('add_to_my_websites'),
      contexts: ['page'],
      id: `page-add-to-my-websites`,
    });

    chrome.contextMenus.create({
      title: chrome.i18n.getMessage('add_to_reading_list'),
      contexts: ['page'],
      id: `page-add-to-reading-list`,
    });

    chrome.contextMenus.create({
      title: chrome.i18n.getMessage('add_to_reading_list'),
      contexts: ['link'],
      id: `link-add-to-reading-list`,
    });
  });

  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({
      url: chrome.i18n.getMessage('enable_ihomepage_url'),
    });
  }
});


chrome.runtime.setUninstallURL(
  chrome.i18n.getMessage('uninstall_ihomepage_url'),
);

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'bookmarks.getTree') {
    (async () => {
      const result = await chrome.bookmarks.getTree();
      sendResponse(result);
    })();
    return true;
  }
});