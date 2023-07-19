import * as Utils from 'src/utils'
import { DstPlaceInfo, HistoryItem, ItemInfo, SubPanelType } from 'src/types'
import { History } from 'src/services/history'
import { Favicons } from 'src/services/favicons'
import { Sidebar } from 'src/services/sidebar'
import { Tabs } from './tabs.fg'
import { Windows } from './windows'
import { Permissions } from './permissions'
import { Containers } from './containers'
import { NOID, PRE_SCROLL, SITE_URL_RE } from 'src/defaults'
import * as Logs from 'src/services/logs'
import { Notifications } from './notifications'
import { translate } from 'src/dict'
import { Settings } from './settings'

const UNLIMITED = 1234567
const INITIAL_COUNT = 100
const LOAD_RANGE = 432_000_000 // 1000*60*60*24*5 - 5 days

let lastItemTime = 0

export async function load(): Promise<void> {
  if (!browser.history) return
  History.ready = false
  History.reactive.ready = false

  const endTime = Date.now()
  const startTime = endTime - LOAD_RANGE
  const result = await browser.history.search({
    text: '',
    endTime,
    startTime,
    maxResults: INITIAL_COUNT,
  })

  const lastItemVisitTime = result[result.length - 1]?.lastVisitTime
  const normList = await normalizeHistory(result, true, lastItemVisitTime)
  lastItemTime = getLastItemTime(normList) - 1

  if (!normList.length) await loadMore()
  else History.reactive.list = normList

  History.setupListeners()

  const historyPanel = Sidebar.panelsById.history
  if (historyPanel) historyPanel.reactive.ready = historyPanel.ready = true
  History.ready = true
  History.reactive.ready = true
}

export function unload(): void {
  History.ready = false
  History.allLoaded = false
  History.reactive.ready = false
  History.reactive.list = []

  const historyPanel = Sidebar.panelsById.history
  if (historyPanel) historyPanel.reactive.ready = historyPanel.ready = false
  History.resetListeners()
  cachedVisits = {}
}

let unloadAfterTimeout: number | undefined
export function unloadAfter(delay: number): void {
  clearTimeout(unloadAfterTimeout)
  unloadAfterTimeout = setTimeout(() => {
    const historyPanel = Sidebar.panelsById.history
    if (historyPanel && Sidebar.activePanelId === historyPanel.id) return
    if (historyPanel && !historyPanel.ready) return
    if (Sidebar.subPanelActive && Sidebar.subPanelType === SubPanelType.History) return

    History.unload()
  }, delay)
}

let cachedVisits: Record<string, browser.history.VisitItem[]> = {}
export async function normalizeHistory(
  items: browser.history.HistoryItem[],
  allVisits: boolean,
  after?: number,
  before?: number
): Promise<HistoryItem[]> {
  const normalized: HistoryItem[] = []

  for (const item of items) {
    if (!item.url) continue
    if (!item.title) item.title = Utils.getDomainOf(item.url)

    normalizeHistoryItem(item)

    if (allVisits && item.visitCount !== undefined && item.visitCount > 1 && item.url) {
      let visits: browser.history.VisitItem[] | undefined = cachedVisits[item.url]
      if (!visits) {
        visits = await browser.history.getVisits({ url: item.url })
        cachedVisits[item.url] = visits
      }
      for (const visit of visits) {
        if (visit.visitTime === undefined) continue
        if (after !== undefined && visit.visitTime < after) continue
        if (before !== undefined && visit.visitTime > before) continue

        const hItem = visit as HistoryItem
        hItem.id += visit.visitTime.toString(36)
        hItem.lastVisitTime = visit.visitTime
        hItem.url = item.url
        hItem.title = item.title
        hItem.visitCount = item.visitCount
        hItem.favicon = (item as HistoryItem).favicon
        normalized.push(hItem)
      }
    } else {
      if (item.lastVisitTime === undefined) continue
      if (after !== undefined && item.lastVisitTime < after) continue
      if (before !== undefined && item.lastVisitTime > before) continue
      normalized.push(item)
    }
  }

  normalized.sort((a, b) => (b.lastVisitTime ?? 0) - (a.lastVisitTime ?? 0))

  return normalized
}

export async function loadMore(): Promise<void> {
  if (History.allLoaded) return

  const before = lastItemTime
  const after = lastItemTime - LOAD_RANGE

  let result = await browser.history.search({
    text: '',
    maxResults: UNLIMITED,
    startTime: after,
    endTime: before,
  })

  // First check
  if (result.length) {
    const newItems = await normalizeHistory(result, true, after, before)
    if (newItems.length) {
      History.reactive.list.push(...newItems)
      lastItemTime = getLastItemTime() - 1
      return
    }
  }

  // If got nothing, try to get next 100 items
  result = await browser.history.search({
    text: '',
    maxResults: 100,
    startTime: 0,
    endTime: before,
  })

  // Second check
  if (result.length) {
    // Find lowest lastVisitTime
    const llvt = result[result.length - 1]?.lastVisitTime ?? 0
    const newItems = await normalizeHistory(result, true, llvt, before)
    if (newItems.length) {
      History.reactive.list.push(...newItems)
      lastItemTime = getLastItemTime() - 1
      return
    }
  }

  // Okay...
  History.allLoaded = true
}

function getLastItemTime(list?: HistoryItem[]): number {
  if (!list) list = History.reactive.list

  let i = list.length - 1
  let lastItem = list[i]
  if (!lastItem) return Date.now()
  while (lastItem?.lastVisitTime === undefined && i > 0) {
    lastItem = list[--i]
  }
  return lastItem.lastVisitTime ?? Date.now()
}

// ???
function normalizeHistoryItem(item: HistoryItem): void {
  if (item.url) {
    const domain = Utils.getDomainOf(item.url)
    item.favicon = Favicons.reactive.list[Favicons.reactive.domains[domain]]
  }
}

function onVisit(item: HistoryItem): void {
  normalizeHistoryItem(item)
  History.reactive.list.unshift(item)
}

function onRemoved(info: browser.history.RemoveDetails): void {
  if (info.allHistory) History.reactive.list = []
  else {
    for (const url of info.urls) {
      const index = History.reactive.list.findIndex(i => i.url === url)
      if (index !== -1) History.reactive.list.splice(index, 1)
    }
  }
}

function onTitleChange(info: browser.history.TitleChangeDetails): void {
  const item = History.reactive.list.find(i => i.url === info.url)
  if (item) item.title = info.title
}

export function setupListeners(): void {
  if (!browser.history) return
  browser.history.onVisited.addListener(onVisit)
  browser.history.onVisitRemoved.addListener(onRemoved)
  browser.history.onTitleChanged.addListener(onTitleChange)
}

export function resetListeners(): void {
  if (!browser.history) return
  browser.history.onVisited.removeListener(onVisit)
  browser.history.onVisitRemoved.removeListener(onRemoved)
  browser.history.onTitleChanged.removeListener(onTitleChange)
}

const scrollConf: ScrollToOptions = { behavior: 'smooth', top: 0 }
export function scrollToHistoryItem(id: string): void {
  const elId = 'history' + id
  const el = document.getElementById(elId)
  if (!el) return

  let scrollEl
  if (Sidebar.subPanelActive) scrollEl = History.subPanelScrollEl
  else scrollEl = History.panelScrollEl
  if (!scrollEl) return

  const sR = scrollEl.getBoundingClientRect()
  const bR = el.getBoundingClientRect()
  const pH = scrollEl.offsetHeight
  const pS = scrollEl.scrollTop
  const bH = el.offsetHeight
  const bY = bR.top - sR.top + pS

  if (bY < pS + PRE_SCROLL) {
    if (pS > 0) {
      let y = bY - PRE_SCROLL
      if (y < 0) y = 0
      scrollConf.top = y
      scrollEl.scroll(scrollConf)
    }
  } else if (bY + bH > pS + pH - PRE_SCROLL) {
    scrollConf.top = bY + bH - pH + PRE_SCROLL
    scrollEl.scroll(scrollConf)
  }
}

export async function open(
  item: HistoryItem,
  dst: DstPlaceInfo,
  useActiveTab?: boolean,
  activateFirstTab?: boolean
): Promise<void> {
  if (!item.url) return

  if (useActiveTab) {
    browser.tabs.update({ url: Utils.normalizeUrl(item.url, item.title) })
    return
  }

  const tabInfo: ItemInfo = { id: 0, url: item.url, title: item.title, active: activateFirstTab }
  const dstInfo: DstPlaceInfo = { windowId: Windows.id, discarded: false, panelId: dst.panelId }
  const panel = Sidebar.panelsById[dstInfo.panelId ?? NOID]
  if (!Utils.isTabsPanel(panel)) return

  dstInfo.panelId = panel.id
  dstInfo.containerId = Containers.getContainerFor(item.url)

  if (!dstInfo.containerId && Containers.reactive.byId[panel.newTabCtx]) {
    dstInfo.containerId = panel.newTabCtx
  }

  if (dst.index !== undefined) dstInfo.index = dst.index

  await Tabs.open([tabInfo], dstInfo)
}

export async function copyUrls(ids: ID[]): Promise<void> {
  if (!Permissions.reactive.clipboardWrite) {
    const result = await Permissions.request('clipboardWrite')
    if (!result) return
  }

  let urls = ''
  for (const id of ids) {
    const item = History.reactive.list.find(i => i.id === id)
    if (item && item.url) urls += '\n' + item.url
  }

  const resultString = urls.trim()
  if (resultString) navigator.clipboard.writeText(resultString)
}

export async function copyTitles(ids: ID[]): Promise<void> {
  if (!Permissions.reactive.clipboardWrite) {
    const result = await Permissions.request('clipboardWrite')
    if (!result) return
  }

  let titles = ''
  for (const id of ids) {
    const item = History.reactive.list.find(i => i.id === id)
    if (item && item.title) titles += '\n' + item.title
  }

  const resultString = titles.trim()
  if (resultString) navigator.clipboard.writeText(resultString)
}

export function deleteVisits(ids: ID[]) {
  for (const id of ids) {
    const list = History.reactive.filtered ?? History.reactive.list
    const itemIndex = list.findIndex(i => i.id === id)
    const item = list[itemIndex]
    if (!item) continue
    if (!item.lastVisitTime) continue

    const ts = item.lastVisitTime

    // Delete cached visit
    if (item.url) {
      const cached = cachedVisits[item.url]
      if (cached) {
        const index = cached.findIndex(ci => ci.visitTime === ts)
        if (index !== -1) cached.splice(index, 1)
      }
    }

    browser.history.deleteRange({ startTime: ts, endTime: ts + 1 })
    list.splice(itemIndex, 1)
  }
}

export async function deleteSites(ids: ID[]) {
  History.reactive.ready = false

  let stopDeletion = false
  const progressNotification = Notifications.progress({
    icon: '#icon_trash',
    title: translate('notif.history_del_sites'),
    progress: { percent: -1 },
    unconcealed: true,
    ctrl: translate('btn.stop'),
    callback: () => {
      stopDeletion = true
    },
  })

  const sites: Set<string> = new Set()

  for (const id of ids) {
    const list = History.reactive.filtered ?? History.reactive.list
    const itemIndex = list.findIndex(i => i.id === id)
    const item = list[itemIndex]
    if (!item || !item.url) continue

    const reResult = SITE_URL_RE.exec(item.url)
    if (reResult?.[1]) sites.add(reResult[1])
  }

  const items = []
  for (const url of sites) {
    delete cachedVisits[url]

    try {
      const result = await browser.history.search({ text: url, maxResults: 999999, startTime: 0 })
      const filteredResults = result.filter(i => i.url?.startsWith(url))
      const visits = await History.normalizeHistory(filteredResults, false)
      items.push(...visits)
    } catch {
      Logs.warn('History.deleteSites: Cannot get visits to remove')
    }
  }

  if (items.length === 0) {
    Notifications.finishProgress(progressNotification, 0)
    Notifications.notify({
      icon: '#icon_clock',
      title: translate('notif.history_del_sites_nothing'),
    })
    History.reactive.ready = true
    return
  }

  const initialCount = items.length + 1
  let count = 1
  Notifications.updateProgress(progressNotification, count, initialCount)

  progressNotification.detailsList = []
  const detailsList = progressNotification.detailsList

  for (const item of items) {
    if (stopDeletion) break
    Notifications.updateProgress(progressNotification, ++count, initialCount)

    if (!item.url) continue

    detailsList[0] = item.url

    try {
      await browser.history.deleteUrl({ url: item.url })
    } catch {
      Logs.warn(`History.deleteSites: Cannot delete url: ${item.url}`)
      continue
    }
  }

  History.unload()
  await History.load()

  Notifications.finishProgress(progressNotification, 0)
}

export interface OpeningHistoryConfig {
  dst: DstPlaceInfo
  useActiveTab: boolean
  activateFirstTab: boolean
}

export function getMouseOpeningConf(button: number): OpeningHistoryConfig {
  const conf: OpeningHistoryConfig = {
    dst: {},
    useActiveTab: false,
    activateFirstTab: false,
  }

  // Left click
  if (button === 0) {
    const panelId = Sidebar.getRecentTabsPanelId()
    conf.useActiveTab = Settings.state.historyLeftClickAction === 'open_in_act'
    conf.activateFirstTab = Settings.state.historyLeftClickActivate
    conf.dst.panelId = panelId
    if (!conf.useActiveTab && Settings.state.historyLeftClickPos === 'after') {
      const activeTab = Tabs.byId[Tabs.activeId]
      if (activeTab && !activeTab.pinned && activeTab.panelId === panelId) {
        conf.dst.index = activeTab.index + 1
        conf.dst.parentId = activeTab.parentId
      }
    }
  }

  // Middle click
  else if (button === 1) {
    const panelId = Sidebar.getRecentTabsPanelId()
    conf.activateFirstTab = Settings.state.historyMidClickActivate
    conf.dst.panelId = panelId
    if (Settings.state.historyMidClickPos === 'after') {
      const activeTab = Tabs.byId[Tabs.activeId]
      if (activeTab && !activeTab.pinned && activeTab.panelId === panelId) {
        conf.dst.index = activeTab.index + 1
        conf.dst.parentId = activeTab.parentId
      }
    }
  }

  return conf
}
