// Exposes: navigate, eval, getTabs, capture
browser.runtime.onMessage.addListener(async (msg) => {
  switch (msg.type) {
    case "navigate":
      const tab = await browser.tabs.query({active:true, currentWindow:true});
      await browser.tabs.update(tab[0].id, {url: msg.url});
      return {ok:true, url: msg.url};
    case "eval": {
      const t = (await browser.tabs.query({active:true, currentWindow:true}))[0];
      const r = await browser.scripting.executeScript({target:{tabId:t.id}, code: msg.code});
      return {ok:true, value: r[0].result};
    }
    case "getTabs": {
      const tabs = await browser.tabs.query({});
      return {ok:true, tabs: tabs.map(t=>({id:t.id, url:t.url, title:t.title}));};
    }
  }
  return {ok:false, error:"unknown type"};
});
