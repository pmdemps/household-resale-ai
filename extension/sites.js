// Per-site settings for the posting helper. Loaded by the content script and the background worker.
// Field finders try several patterns because these sites change their forms; anything not found is left
// for the person to fill in, and the on-page panel says so.
//
// Vinted is deliberately absent: they suspend accounts that automate their site (AGENTS.md).

globalThis.RHQ_SITES = {
  mercari: {
    name: "Mercari",
    host: "www.mercari.com",
    sellUrl: "https://www.mercari.com/sell/",
    isSellPage: url => /^\/(us\/)?sell\/?/.test(url.pathname),
    // After posting, Mercari opens the new item: /us/item/m12345678901/
    listingFromUrl: url => {
      const m = url.pathname.match(/\/item\/(m\d{6,})/);
      return m ? { externalId: m[1], url: `https://www.mercari.com/us/item/${m[1]}/` } : null;
    },
    fields: {
      title: ['input[data-testid="Title"]', 'input[name="name"]', 'input[placeholder*="title" i]', 'input[aria-label*="title" i]'],
      description: ['textarea[data-testid="Description"]', 'textarea[name="description"]', 'textarea[placeholder*="describe" i]', "textarea"],
      price: ['input[data-testid="Price"]', 'input[name="price"]', 'input[placeholder*="price" i]', 'input[aria-label*="price" i]'],
    },
    postButtonText: "List",
    pickByHand: ["Category", "Brand", "Size", "Condition", "Shipping"],
  },
  poshmark: {
    name: "Poshmark",
    host: "poshmark.com",
    sellUrl: "https://poshmark.com/create-listing",
    isSellPage: url => url.pathname.startsWith("/create-listing"),
    // After posting, Poshmark opens the listing: /listing/Some-Title-<24 hex id>
    listingFromUrl: url => {
      const m = url.pathname.match(/^\/listing\/[^/]*?([0-9a-f]{24})\/?$/i);
      return m ? { externalId: m[1], url: `https://poshmark.com${url.pathname}` } : null;
    },
    fields: {
      title: ['input[data-vv-name="title"]', 'input[name="title"]', 'input[placeholder*="what are you selling" i]', 'input[placeholder*="title" i]'],
      description: ['textarea[data-vv-name="description"]', 'textarea[name="description"]', 'textarea[placeholder*="describe" i]', "textarea"],
      price: ['input[data-vv-name="listingPrice"]', 'input[name="listingPrice"]', 'input[placeholder*="listing price" i]'],
    },
    postButtonText: "Next, then List",
    pickByHand: ["Category", "Size", "Brand", "Condition (New with tags is a checkbox)", "Original price", "Color"],
  },
  facebook: {
    name: "Facebook Marketplace",
    host: "www.facebook.com",
    sellUrl: "https://www.facebook.com/marketplace/create/item",
    isSellPage: url => url.pathname.startsWith("/marketplace/create/item"),
    // Facebook doesn't open the new listing, so the person confirms with the panel's button.
    listingFromUrl: () => null,
    fields: {
      title: ['label[aria-label="Title"] input', 'input[aria-label="Title"]', 'input[aria-label*="title" i]'],
      description: ['label[aria-label="Description"] textarea', 'textarea[aria-label*="description" i]', "textarea"],
      price: ['label[aria-label="Price"] input', 'input[aria-label="Price"]', 'input[aria-label*="price" i]'],
    },
    postButtonText: "Next, then Publish",
    pickByHand: ["Category", "Condition", "Location"],
    // House rule: Marketplace only, never shared, always hidden from friends.
    rules: [
      "Turn ON \"Hide from friends\" before you publish.",
      "Don't share it to your feed, Stories or groups. Marketplace only.",
    ],
  },
};
