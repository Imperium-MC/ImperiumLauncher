/**
 * Small DOM construction helpers.
 *
 * Dynamic text is always attached with textContent and dynamic identifiers
 * with setAttribute, so nothing that originates outside the launcher is ever
 * parsed as HTML. Static markup (language strings shipped with the app) may
 * still be assigned through innerHTML at the call site.
 */

/**
 * Escape a string so it can be embedded in trusted HTML without the
 * value being interpreted as markup. Used for dynamic fragments that are
 * rendered by sinks which intentionally accept trusted HTML.
 *
 * @param {string} str The value to escape.
 * @returns {string} The escaped value.
 */
exports.escapeHtml = function(str){
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

/**
 * Create an element and populate it in one call.
 *
 * @param {string} tag The tag name.
 * @param {Object} [attrs] Attributes to set via setAttribute. Values are
 * treated as plain strings, never markup.
 * @param {Node[]|NodeList|Node|string} [children] Children to append.
 * Strings are added as text nodes via textContent.
 * @returns {HTMLElement} The constructed element.
 */
function el(tag, attrs, children){
    const node = document.createElement(tag)
    if(attrs != null){
        for(const [key, val] of Object.entries(attrs)){
            if(val != null){
                node.setAttribute(key, val)
            }
        }
    }
    if(children != null){
        if(typeof children === 'string' || typeof children === 'number'){
            node.textContent = children
        } else if(children instanceof Node){
            node.appendChild(children)
        } else {
            for(const child of children){
                if(child == null){
                    continue
                }
                node.appendChild(
                    typeof child === 'string' || typeof child === 'number'
                        ? document.createTextNode(String(child))
                        : child
                )
            }
        }
    }
    return node
}
exports.el = el

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Create an SVG-namespaced element with attributes.
 *
 * @param {string} tag The SVG tag name.
 * @param {Object} [attrs] Attributes to set via setAttribute.
 * @returns {SVGElement} The constructed element.
 */
function svgEl(tag, attrs){
    const node = document.createElementNS(SVG_NS, tag)
    if(attrs != null){
        for(const [key, val] of Object.entries(attrs)){
            if(val != null){
                node.setAttribute(key, val)
            }
        }
    }
    return node
}
exports.svgEl = svgEl

/**
 * Build the static "main server" star badge used by server listings.
 * Built entirely through the DOM API so no markup string is parsed.
 *
 * @param {string} tooltipText The badge tooltip text.
 * @returns {HTMLElement} The badge wrapper.
 */
exports.buildStarBadge = function(tooltipText){
    const wrapper = document.createElement('div')
    wrapper.className = 'serverListingStarWrapper'

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('id', 'Layer_1')
    svg.setAttribute('viewBox', '0 0 107.45 104.74')
    svg.setAttribute('width', '20px')
    svg.setAttribute('height', '20px')

    const defs = document.createElementNS(SVG_NS, 'defs')
    const style = document.createElementNS(SVG_NS, 'style')
    style.textContent = '.cls-1{fill:#fff;}.cls-2{fill:none;stroke:#fff;stroke-miterlimit:10;}'
    defs.appendChild(style)

    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('class', 'cls-1')
    path.setAttribute('d', 'M100.93,65.54C89,62,68.18,55.65,63.54,52.13c2.7-5.23,18.8-19.2,28-27.55C81.36,31.74,63.74,43.87,58.09,45.3c-2.41-5.37-3.61-26.52-4.37-39-.77,12.46-2,33.64-4.36,39-5.7-1.46-23.3-13.57-33.49-20.72,9.26,8.37,25.39,22.36,28,27.55C39.21,55.68,18.47,62,6.52,65.55c12.32-2,33.63-6.06,39.34-4.9-.16,5.87-8.41,26.16-13.11,37.69,6.1-10.89,16.52-30.16,21-33.9,4.5,3.79,14.93,23.09,21,34C70,86.84,61.73,66.48,61.59,60.65,67.36,59.49,88.64,63.52,100.93,65.54Z')

    const circle = document.createElementNS(SVG_NS, 'circle')
    circle.setAttribute('class', 'cls-2')
    circle.setAttribute('cx', '53.73')
    circle.setAttribute('cy', '53.9')
    circle.setAttribute('r', '38')

    svg.appendChild(defs)
    svg.appendChild(path)
    svg.appendChild(circle)

    const tooltip = document.createElement('span')
    tooltip.className = 'serverListingStarTooltip'
    tooltip.textContent = tooltipText

    wrapper.appendChild(svg)
    wrapper.appendChild(tooltip)
    return wrapper
}

/**
 * Build the body shared by server listings: the icon image and the
 * details column. Server names, descriptions and versions originate in
 * the distribution index, so every value is attached as text or a plain
 * attribute, never as markup.
 *
 * @param {Object} rawServer The raw server object from the index.
 * @param {string} mainServerTooltip Tooltip text for the main-server badge.
 * @returns {Node[]} Children to append to the listing container.
 */
exports.buildServerListingChildren = function(rawServer, mainServerTooltip){
    const info = el('div', { class: 'serverListingInfo' }, [
        el('div', { class: 'serverListingVersion' }, rawServer.minecraftVersion),
        el('div', { class: 'serverListingRevision' }, rawServer.version)
    ])
    if(rawServer.mainServer){
        info.appendChild(exports.buildStarBadge(mainServerTooltip))
    }

    return [
        el('img', { class: 'serverListingImg', src: rawServer.icon }),
        el('div', { class: 'serverListingDetails' }, [
            el('span', { class: 'serverListingName' }, rawServer.name),
            el('span', { class: 'serverListingDescription' }, rawServer.description),
            info
        ])
    ]
}
