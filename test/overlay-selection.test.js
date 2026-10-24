/**
 * The account and server pickers in overlay.js, run in a vm context with
 * a minimal fake DOM (the renderer script has no module exports).
 */
const test   = require('node:test')
const assert = require('node:assert')
const fs     = require('fs')
const path   = require('path')
const vm     = require('vm')

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'assets', 'js', 'scripts', 'overlay.js'), 'utf8')

class FakeElement {
    constructor(tag = 'div', attrs = {}){
        this.tag = tag
        this.attrs = Object.assign({}, attrs)
        this.children = []
        this.listeners = {}
        this.style = {}
    }
    setAttribute(k, v){ this.attrs[k] = String(v) }
    getAttribute(k){ return k in this.attrs ? this.attrs[k] : null }
    hasAttribute(k){ return k in this.attrs }
    removeAttribute(k){ delete this.attrs[k] }
    appendChild(c){ this.children.push(c); return c }
    replaceChildren(...nodes){
        this.children = nodes.flatMap(n => n instanceof FakeFragment ? n.children : [n])
    }
    addEventListener(type, fn){ this.listeners[type] = fn }
    getElementsByClassName(){ return [] }
}

class FakeFragment extends FakeElement {}

function loadOverlay({ accounts, selectedAccount, servers = [], selectedServer = null }){
    const byId = {}
    const document = {
        getElementById: (id) => (byId[id] ??= new FakeElement('div', { id })),
        getElementsByClassName: (cls) => Object.values(byId)
            .flatMap(el => el.children)
            .filter(el => el.attrs.class === cls),
        createDocumentFragment: () => new FakeFragment(),
        addEventListener(){},
        removeEventListener(){},
        activeElement: { blur(){} }
    }
    const calls = { updateSelectedServer: [], setSelectedAccount: [] }
    const ctx = {
        document,
        RenderUtil: {
            el: (tag, attrs, text) => Object.assign(new FakeElement(tag, attrs), { text }),
            buildServerListingChildren: () => []
        },
        ConfigManager: {
            getAuthAccounts: () => accounts,
            getSelectedAccount: () => accounts[selectedAccount],
            getSelectedServer: () => selectedServer,
            setSelectedAccount: (uuid) => { calls.setSelectedAccount.push(uuid); return accounts[uuid] },
            save(){}
        },
        DistroAPI: {
            getDistribution: async () => ({
                servers,
                getServerById: (id) => servers.find(s => s.rawServer.id === id)
            })
        },
        Lang: { queryJS: (k) => k },
        updateSelectedServer: (s) => calls.updateSelectedServer.push(s),
        refreshServerStatus(){},
        $: () => ({ fadeOut(){}, fadeIn(){}, show(){}, hide(){}, attr(){}, removeAttr(){}, parent(){ return this }, children(){ return this } }),
        console
    }
    vm.createContext(ctx)
    vm.runInContext(SRC, ctx)
    return { ctx, document, calls, byId }
}

const ACCOUNTS = {
    aaaa: { uuid: 'aaaa', displayName: 'Marcus' },
    bbbb: { uuid: 'bbbb', displayName: 'Livia' },
    cccc: { uuid: 'cccc', displayName: 'Titus' }
}

test('the account picker preselects the selected account, not the first one', () => {
    const { ctx, byId } = loadOverlay({ accounts: ACCOUNTS, selectedAccount: 'bbbb' })
    ctx.prepareAccountSelectionList()
    const listings = byId.accountSelectListScrollable.children
    const preselected = listings.filter(l => l.hasAttribute('selected')).map(l => l.getAttribute('uuid'))
    assert.deepStrictEqual(preselected, ['bbbb'])
})

test('the account picker falls back to the first account when none is selected', () => {
    const { ctx, byId } = loadOverlay({ accounts: ACCOUNTS, selectedAccount: null })
    ctx.prepareAccountSelectionList()
    const preselected = byId.accountSelectListScrollable.children.filter(l => l.hasAttribute('selected'))
    assert.strictEqual(preselected.length, 1)
    assert.strictEqual(preselected[0].getAttribute('uuid'), 'aaaa')
})
