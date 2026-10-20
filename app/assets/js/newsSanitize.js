/**
 * Sanitizing wrapper for article HTML and the external link policy.
 *
 * Two exports are consumed from different worlds:
 *  - isAllowedLink(url) is a pure function, usable in the main process and
 *    in plain node (tests) without a DOM.
 *  - sanitizeHtml(html) / setSanitizedHtml(element, html) need a DOM (the
 *    renderer) and run DOMPurify with a strict allowlist. If DOMPurify or
 *    the DOM cannot be initialized the functions fail closed and render
 *    nothing, so unsanitized markup can never reach a live document.
 *
 * The module is dual-mode: in node it is requireable as usual, in the
 * sandboxed renderer (plain <script>, no require) it attaches itself to
 * window.NewsSanitize. DOMPurify comes from require in node contexts and
 * from the vendored window.DOMPurify script in the renderer.
 */
(function(factory){
    if(typeof module === 'object' && module.exports){
        module.exports = factory()
    } else {
        window.NewsSanitize = factory()
    }
})(function(){
    const exports = {}

    // Hosts the launcher is allowed to hand to the OS browser. First-party
    // site plus the hosts referenced by shipped strings and update metadata.
    const ALLOWED_LINK_HOSTS = [
        'imperiummc.net',
        'github.com',
        'docs.oracle.com',
        'minecraft.net'
    ]

    /**
     * Determine whether a URL may be opened externally / set as a link target.
     * Accepts absolute https URLs whose hostname is an allowed host or one of
     * its subdomains. Everything else (other schemes, relative or malformed
     * URLs) is rejected.
     *
     * @param {string} url The URL to check.
     * @returns {boolean} True if the URL is allowed.
     */
    exports.isAllowedLink = function(url){
        if(typeof url !== 'string' || url.length === 0){
            return false
        }
        // Control characters have no business in a link target.
        if(/[\u0000-\u001f\u007f]/.test(url)){
            return false
        }
        let parsed
        try {
            parsed = new URL(url)
        } catch(_err){
            return false
        }
        if(parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''){
            return false
        }
        const host = parsed.hostname.toLowerCase()
        return ALLOWED_LINK_HOSTS.some(allowed =>
            host === allowed || host.endsWith('.' + allowed)
        )
    }

    // Strict article allowlist: paragraphs, links, basic inline formatting,
    // lists, images and headings. No style attributes, no event handlers,
    // no classes survive sanitization.
    const ALLOWED_TAGS = ['p', 'a', 'b', 'i', 'em', 'strong', 'ul', 'ol', 'li', 'img', 'h1', 'h2', 'h3', 'br']
    const ALLOWED_ATTR = ['href', 'src', 'alt', 'title']

    let purify = null
    let purifyFailed = false

    function getPurify(){
        if(purify != null){
            return purify
        }
        if(purifyFailed || typeof window === 'undefined' || window == null){
            return null
        }
        try {
            // In node (tests, main) DOMPurify is requireable; in the
            // sandboxed renderer there is no require and the vendored
            // browser build exposes window.DOMPurify.
            let loaded
            if(typeof require === 'function'){
                loaded = require('dompurify')
            } else {
                loaded = window.DOMPurify
            }
            // The CJS build exposes a factory when no global window exists
            // (plain node) and a ready instance when one does (the renderer).
            const instance = typeof loaded === 'function' ? loaded(window) : loaded
            if(instance == null || typeof instance.sanitize !== 'function' || !instance.isSupported){
                throw new Error('DOMPurify is not supported in this environment.')
            }
            purify = instance

            // Enforce the https + host policy on every surviving href/src.
            purify.addHook('afterSanitizeAttributes', node => {
                if(node.hasAttribute && node.hasAttribute('href') && !exports.isAllowedLink(node.getAttribute('href'))){
                    node.removeAttribute('href')
                }
                if(node.hasAttribute && node.hasAttribute('src') && !exports.isAllowedLink(node.getAttribute('src'))){
                    node.removeAttribute('src')
                }
            })

            return purify
        } catch(_err){
            // Fail closed: no DOMPurify, no rendered markup.
            purifyFailed = true
            return null
        }
    }

    /**
     * Sanitize untrusted article HTML with the strict allowlist. Non-https
     * and non-allowlisted link targets are stripped during sanitization.
     *
     * @param {string} html The untrusted HTML string.
     * @returns {string} Sanitized HTML safe to assign via innerHTML.
     */
    exports.sanitizeHtml = function(html){
        const dompurify = getPurify()
        if(dompurify == null){
            return ''
        }
        return dompurify.sanitize(String(html), {
            ALLOWED_TAGS,
            ALLOWED_ATTR,
            ALLOW_DATA_ATTR: false,
            ALLOW_ARIA_ATTR: false,
            KEEP_CONTENT: true
        })
    }

    /**
     * Replace an element's content with the sanitized form of untrusted HTML.
     * This is the single place in the renderer where sanitized markup is
     * assigned through innerHTML.
     *
     * @param {HTMLElement} element The element to populate.
     * @param {string} html The untrusted HTML string.
     */
    exports.setSanitizedHtml = function(element, html){
        element.innerHTML = exports.sanitizeHtml(html)
    }

    return exports
})
