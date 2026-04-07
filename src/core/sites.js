const SITE_DEFINITIONS = [
  {
    key: "booktoki",
    label: "북토끼",
    outputFolderName: "북토끼",
    titleToken: "북토끼",
    domainPattern: /^https:\/\/booktoki\d+\.com/,
    urlPattern: /^https:\/\/booktoki\d+\.com\/novel\/\d+/,
    listSelector: ".list-body",
    paginationSelector: 'ul.pagination li[class="active"] ~ li:not([class="disabled"]) a',
    contentTitleSelector: ".page-title .page-desc",
    chapterContentSelector: "#novel_content",
    contentType: "text",
  },
  {
    key: "newtoki",
    label: "뉴토끼",
    outputFolderName: "뉴토끼",
    titleToken: "뉴토끼",
    domainPattern: /^https:\/\/newtoki\d+\.com/,
    urlPattern: /^https:\/\/newtoki\d+\.com\/webtoon\/\d+/,
    listSelector: ".list-body",
    paginationSelector: 'ul.pagination li[class="active"] ~ li:not([class="disabled"]) a',
    contentTitleSelector: ".page-title .page-desc",
    chapterImageSelector: ".view-padding div img",
    contentType: "images",
  },
  {
    key: "manatoki",
    label: "마나토끼",
    outputFolderName: "마나토끼",
    titleToken: "마나토끼",
    domainPattern: /^https:\/\/manatoki\d+\.net/,
    urlPattern: /^https:\/\/manatoki\d+\.net\/comic\/\d+/,
    listSelector: ".list-body",
    paginationSelector: 'ul.pagination li[class="active"] ~ li:not([class="disabled"]) a',
    contentTitleSelector: ".page-title .page-desc",
    chapterImageSelector: ".view-padding div img",
    contentType: "images",
  },
];

export function getSiteDefinitions() {
  return SITE_DEFINITIONS.map((site) => ({ ...site }));
}

export function detectSite(url) {
  return SITE_DEFINITIONS.find((site) => site.urlPattern.test(url)) ?? null;
}

export function getSiteDefinitionByKey(key) {
  return SITE_DEFINITIONS.find((site) => site.key === key) ?? null;
}

export function getProtocolDomain(site, url) {
  const matchedDomain = url.match(site.domainPattern);

  return matchedDomain ? matchedDomain[0] : "";
}
