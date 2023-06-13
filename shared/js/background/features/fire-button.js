import browser from 'webextension-polyfill'
import { registerMessageHandler } from '../message-handlers'
import { getCurrentTab } from '../utils'
import { getExtensionURL } from '../wrapper'
import { getDomain, parse } from 'tldts'

/**
 * @typedef {object} BurnConfig
 * @property {boolean} closeTabs
 * @property {boolean} clearHistory
 * @property {number} [since]
 * @property {string[]} [origins]
 */

export default class FireButton {
    /**
     * @param {{
     *  settings: { getSetting(name: string): boolean }
     * }}
     */
    constructor ({ settings }) {
        this.settings = settings
        registerMessageHandler('doBurn', this.burn.bind(this))
        registerMessageHandler('getBurnOptions', this.getBurnOptions.bind(this))
        registerMessageHandler('fireAnimationComplete', this.onFireAnimationComplete.bind(this))
    }

    getDefaultSettings () {
        return {
            closeTabs: this.settings.getSetting('fireButtonTabClearEnabled'),
            clearHistory: this.settings.getSetting('fireButtonHistoryEnabled'),
            since: undefined
        }
    }

    /**
     * @param {Partial<BurnConfig>} options
     * @returns {Promise<boolean>}
     */
    async burn (options) {
        /** @type {BurnConfig} config */
        const config = Object.assign(this.getDefaultSettings(), options)

        console.log('🔥', config)
        if (config.closeTabs) {
            await this.closeAllTabs(config.origins)
        }
        // 1/ Clear downloads and history
        const clearing = []
        if (!config.origins || config.origins.length === 0) {
            clearing.push(chrome.browsingData.remove({
                since: config.since
            }, {
                downloads: true,
                history: config.clearHistory
            }))
        }
        // TODO: handle clearing downloads and history for specific origins

        // 2/ Clear cookies, except on SERP
        const cookieOptions = {
            since: config.since
        }
        if (config.origins) {
            cookieOptions.origins = config.origins
        } else {
            cookieOptions.excludeOrigins = ['https://duckduckgo.com']
        }
        clearing.push(chrome.browsingData.remove(cookieOptions, {
            cookies: true
        }))
        // 3/ Clear origin-keyed storage
        clearing.push(chrome.browsingData.remove({
            origins: config.origins,
            since: config.since
        }, {
            appcache: true,
            cache: true,
            cacheStorage: true,
            indexedDB: true,
            fileSystems: true,
            localStorage: true,
            serviceWorkers: true,
            webSQL: true
        }))
        try {
            const results = await Promise.all(clearing)
            console.log('🔥 result', results)
            return true
        } catch (e) {
            console.warn('🔥 error', e)
            return false
        }
    }

    /**
     * @param {string[]} [origins] Only close tabs for these origins
     */
    async closeAllTabs (origins) {
        // gather all non-pinned tabs
        const openTabs = (await browser.tabs.query({
            pinned: false
        })).filter(tabMatchesOriginFilter(origins))
        const removeTabIds = openTabs.map(t => t.id || 0)
        // create a new tab which will be open after the burn
        await browser.tabs.create({
            active: true,
            url: getExtensionURL('/html/fire.html')
        })
        // remove the rest of the open tabs
        await browser.tabs.remove(removeTabIds)
    }

    /**
     * Get options to display in the burn modal
     * @returns {Promise<import('@duckduckgo/privacy-dashboard/schema/__generated__/schema.types').FireButtonData>}
     */
    async getBurnOptions () {
        const ONE_HOUR = 60 * 60 * 1000
        const [currentTab, allTabs, allCookies] = await Promise.all([
            getCurrentTab(),
            browser.tabs.query({}),
            browser.cookies.getAll({})
        ])
        /** @type {import('@duckduckgo/privacy-dashboard/schema/__generated__/schema.types').FireOption[]} */
        const options = []
        try {
            const origins = getOriginsForUrl(currentTab?.url)
            console.log('xxx', origins)
            const tabsMatchingOrigin = allTabs.filter(tabMatchesOriginFilter(origins)).length
            options.push({
                name: 'Current site only',
                options: {
                    origins
                },
                descriptionStats: {
                    history: 'current site',
                    openTabs: tabsMatchingOrigin,
                    cookies: 1
                }
            })
        } catch (e) {
            // not a valid URL, skip 'current site' option
        }
        const openTabs = allTabs.filter(t => !t.pinned).length
        const cookies = allCookies.reduce((sites, curr) => {
            sites.add(curr.domain)
            return sites
        }, new Set()).size

        options.push({
            name: 'Last hour',
            options: {
                since: Date.now() - ONE_HOUR
            },
            descriptionStats: {
                history: 'last hour',
                openTabs,
                cookies
            }
        })
        options.push({
            name: 'Last day',
            options: {
                since: Date.now() - (24 * ONE_HOUR)
            },
            descriptionStats: {
                history: 'last day',
                openTabs,
                cookies
            }
        })
        options.push({
            name: 'Last 7 day',
            options: {
                since: Date.now() - (7 * 24 * ONE_HOUR)
            },
            descriptionStats: {
                history: 'last 7 days',
                openTabs,
                cookies
            }
        })
        options.push({
            name: 'Last 4 weeks',
            options: {
                since: Date.now() - (4 * 7 * 24 * ONE_HOUR)
            },
            descriptionStats: {
                history: 'last 4 weeks',
                openTabs,
                cookies
            }
        })
        options.push({
            name: 'All time',
            options: {},
            descriptionStats: {
                history: 'all',
                openTabs,
                cookies
            }
        })

        // Apply defaults for history and tab clearing
        const { closeTabs, clearHistory } = this.getDefaultSettings()
        options.forEach((opt) => {
            if (!closeTabs) {
                opt.descriptionStats.openTabs = undefined
            }
            if (!clearHistory) {
                opt.descriptionStats.history = undefined
            }
        })

        return {
            options
        }
    }

    async onFireAnimationComplete (msg, sender) {
        const fireTabId = sender.tab.id
        chrome.tabs.update(fireTabId, {
            url: 'chrome://newtab'
        })
    }
}

function getOriginsForUrl (url) {
    const origins = []
    const { subdomain, domain } = parse(url, { allowPrivateDomains: true })
    origins.push(`https://${domain}`)
    origins.push(`http://${domain}`)
    if (subdomain) {
        const subParts = subdomain.split('.').reverse()
        for (let i = 1; i <= subParts.length; i++) {
            const sd = subParts.slice(0, i).reverse().join('.') + '.' + domain
            origins.push(`https://${sd}`)
            origins.push(`http://${sd}`)
        }
    }
    return origins
}

function tabMatchesOriginFilter (origins) {
    const etldPlusOnes = new Set()
    origins.forEach(o => etldPlusOnes.add(getDomain(o, { allowPrivateDomains: true })))
    return tab => etldPlusOnes.has(getDomain(tab.url, { allowPrivateDomains: true }))
}