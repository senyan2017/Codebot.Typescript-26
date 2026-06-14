"use strict";
/**
 * Unified resource loader for the boot pipeline.
 *
 * Responsibility: loading scripts, stylesheets and HTML fragments with
 * deduplication.  Shared by the Boot startup sequencer (boot.ts) and
 * the runtime DOM helpers (codebot.dom.element.ts) so that both sides
 * see the same loaded-resource registry and never double-load a file.
 */
/**
 * Singleton that tracks every resource the page has requested and
 * exposes low-level loaders for scripts, stylesheets and text fragments.
 *
 * A global instance is created as `ResourceLoader` at script-eval time
 * (boot.js loads first, so it is available to both the boot sequencer
 * and the later app.js bundle).
 */
class ResourceLoader {
    constructor() {
        /** Every URL that has been requested, keyed by url. */
        this.registry = {};
    }
    // ------------------------------------------------------------------
    //  Registry helpers
    // ------------------------------------------------------------------
    /** True when `url` has already been queued or loaded. */
    isLoaded(url) {
        return this.registry.hasOwnProperty(url);
    }
    /** Mark a URL as seen (loaded = true). */
    markLoaded(url, type) {
        this.registry[url] = { url: url, type: type, loaded: true };
    }
    /** Return a snapshot of every registered resource. */
    getEntries() {
        const out = [];
        for (const key in this.registry) {
            if (this.registry.hasOwnProperty(key))
                out.push(this.registry[key]);
        }
        return out;
    }
    // ------------------------------------------------------------------
    //  Low-level loaders
    // ------------------------------------------------------------------
    /**
     * Insert a `<script>` element and invoke `onload` once it finishes.
     * Duplicate URLs are silently skipped (callback still fires).
     */
    loadScript(url, onload) {
        if (this.isLoaded(url)) {
            if (onload)
                onload();
            return;
        }
        this.markLoaded(url, "script");
        const script = document.createElement("script");
        script.type = "text/javascript";
        script.src = url;
        if (onload)
            script.onload = function () { onload(); };
        document.body.appendChild(script);
    }
    /**
     * Insert a `<link rel="stylesheet">` element and invoke `onload`
     * once the sheet has loaded.  Duplicate URLs are silently skipped.
     */
    loadStyleSheet(url, onload) {
        if (this.isLoaded(url)) {
            if (onload)
                onload();
            return;
        }
        this.markLoaded(url, "stylesheet");
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = url;
        if (onload)
            link.onload = function () { onload(); };
        const head = document.getElementsByTagName("head")[0];
        if (head)
            head.appendChild(link);
    }
    /**
     * Fetch a text resource via XHR.  Deduplicates by URL so the same
     * fragment is not fetched twice during the include-processing pass.
     */
    loadText(url, onload) {
        if (this.isLoaded(url)) {
            onload("");
            return;
        }
        this.markLoaded(url, "text");
        const request = new XMLHttpRequest();
        request.open("GET", url, true);
        request.onload = function () { onload(request.response); };
        request.send();
    }
    // ------------------------------------------------------------------
    //  Composite helpers
    // ------------------------------------------------------------------
    /**
     * Drain all `<include>` elements in document order.
     *
     * - `.js`  sources become script loads.
     * - `.css` sources become stylesheet loads.
     * - Anything else is treated as an HTML fragment URL: its content
     *   is fetched via XHR and the resulting child nodes are spliced
     *   into the DOM in place of the `<include>` element.
     *
     * The method is **recursive**: after a pass completes it re-scans
     * for new `<include>` elements that may have been introduced by an
     * HTML fragment, and only calls `oncomplete` when no more remain.
     *
     * Elements with a `target-platform` attribute are skipped when the
     * current device does not match ("mobile" vs "desktop").
     */
    processHtmlIncludes(oncomplete) {
        var _a, _b;
        const self = this;
        function isWrongPlatform(el) {
            const target = el.getAttribute("target-platform");
            if (!target)
                return false;
            const isDesktop = typeof window.orientation === "undefined";
            return target === "mobile" ? isDesktop : !isDesktop;
        }
        function toElementArray(items) {
            return Array.prototype.slice.call(items);
        }
        const includes = toElementArray(document.getElementsByTagName("include"));
        let pending = includes.length;
        if (pending === 0) {
            oncomplete();
            return;
        }
        function tick() {
            pending--;
            if (pending === 0)
                self.processHtmlIncludes(oncomplete);
        }
        for (const item of includes) {
            const src = item.getAttribute("src");
            if (src === null)
                break;
            if (src.endsWith(".css")) {
                (_a = item.parentNode) === null || _a === void 0 ? void 0 : _a.removeChild(item);
                if (self.isLoaded(src) || isWrongPlatform(item)) {
                    tick();
                    continue;
                }
                self.loadStyleSheet(src, tick);
            }
            else if (src.endsWith(".js")) {
                (_b = item.parentNode) === null || _b === void 0 ? void 0 : _b.removeChild(item);
                if (self.isLoaded(src) || isWrongPlatform(item)) {
                    tick();
                    continue;
                }
                self.loadScript(src, tick);
            }
            else {
                const parent = item.parentNode;
                const next = item.nextSibling;
                parent === null || parent === void 0 ? void 0 : parent.removeChild(item);
                self.loadText(src, function (html) {
                    const container = item;
                    container.innerHTML = html;
                    const children = toElementArray(container.children);
                    while (children.length) {
                        const node = children.shift();
                        if (node)
                            parent === null || parent === void 0 ? void 0 : parent.insertBefore(node, next);
                    }
                    tick();
                });
            }
        }
    }
}
/** Global singleton — created once when boot.js evaluates. */
const resourceLoader = new ResourceLoader();
/// <reference path="boot.resource.ts" />
function get(query) {
    if (typeof query == "string")
        return document.querySelector(query);
    if (query instanceof HTMLElement)
        return query;
    return query[0];
}
function getAll(query) {
    if (typeof query == "string") {
        let nodes = document.querySelectorAll(query);
        return Array.prototype.slice.call(nodes);
    }
    if (query instanceof HTMLElement)
        return [query];
    return query;
}
HTMLElement.prototype.get = function (query) {
    if (typeof query == "string")
        return this.querySelector(query);
    if (query instanceof HTMLElement)
        return query;
    return query[0];
};
HTMLElement.prototype.getAll = function (query) {
    if (typeof query == "string") {
        let nodes = this.querySelectorAll(query);
        return Array.prototype.slice.call(nodes);
    }
    if (query instanceof HTMLElement)
        return [query];
    return query;
};
if (!String.prototype.includes) {
    String.prototype.includes = function (search, start) {
        if (typeof start !== 'number') {
            start = 0;
        }
        if (start + search.length > this.length) {
            return false;
        }
        else {
            return this.indexOf(search, start) !== -1;
        }
    };
}
if (!String.prototype.startsWith) {
    String.prototype.startsWith = function (searchString, position) {
        position = position || 0;
        return this.substr(position, searchString.length) === searchString;
    };
}
if (!String.prototype.endsWith) {
    String.prototype.endsWith = function (searchString, position) {
        var subjectString = this.toString();
        if (typeof position !== 'number' || !isFinite(position) || Math.floor(position) !== position || position > subjectString.length) {
            position = subjectString.length;
        }
        position -= searchString.length;
        var lastIndex = subjectString.lastIndexOf(searchString, position);
        return lastIndex !== -1 && lastIndex === position;
    };
}
const BOOT_MODULE_ENTRIES = {
    "ace": {
        url: "https://cdnjs.cloudflare.com/ajax/libs/ace/1.2.5/ace.js",
        identifier: "Ace"
    },
    "greensock": {
        url: "http://cdnjs.cloudflare.com/ajax/libs/gsap/1.19.0/TweenMax.min.js",
        identifier: "TweenMax"
    },
    "jquery": {
        url: "https://ajax.googleapis.com/ajax/libs/jquery/2.1.3/jquery.min.js",
        identifier: "jQuery"
    },
    "rivets": {
        url: "https://cdnjs.cloudflare.com/ajax/libs/rivets/0.9.4/rivets.bundled.min.js",
        identifier: "rivets"
    },
    "three": {
        url: "https://cdnjs.cloudflare.com/ajax/libs/three.js/r80/three.min.js",
        identifier: "THREE"
    }
};
/**
 * Orchestrates the page boot sequence.
 *
 * The startup pipeline runs in three ordered phases:
 *   1. processIncludes  – drain all <include> elements (HTML fragments,
 *                         stylesheets, scripts) via ResourceLoader.
 *   2. processUses      – load CDN module scripts registered via use().
 *   3. processRequires  – load application scripts registered via require().
 *
 * Once all three phases complete, window.main() is invoked if present.
 *
 * Resource loading is fully delegated to the global `resourceLoader`
 * singleton (defined in boot.resource.ts), which also provides dedup
 * so that the same URL is never loaded twice regardless of which
 * phase or code path requested it.
 */
class Boot {
    /** @internal */
    start() {
        if (this.included && this.loaded) {
            if (typeof window["main"] === "function") {
                console.log("started");
                window["main"]();
            }
        }
    }
    /**
     * Phase 1: process all <include> elements in the document.
     * Re-runs recursively until no <include> elements remain
     * (HTML fragments may introduce new includes).
     * @internal
     */
    processIncludes() {
        const me = this;
        resourceLoader.processHtmlIncludes(function () {
            me.included = true;
            me.start();
        });
    }
    /**
     * Phase 2: load all CDN modules registered via use().
     * @internal
     */
    processUses() {
        const me = this;
        const entries = BOOT_MODULE_ENTRIES;
        function load() {
            me.moduleCount--;
            if (me.moduleCount == 0) {
                me.processRequires();
            }
        }
        me.moduleCount = me.modules.length;
        if (me.moduleCount == 0) {
            me.moduleCount = 1;
            load();
            return;
        }
        for (const key of me.modules) {
            const entry = entries[key];
            if (!entry || resourceLoader.isLoaded(entry.url)) {
                load();
                continue;
            }
            resourceLoader.loadScript(entry.url, load);
        }
    }
    /**
     * Phase 3: load all scripts registered via require().
     * @internal
     */
    processRequires() {
        const me = this;
        function load() {
            me.requireCount--;
            if (me.requireCount == 0) {
                me.loaded = true;
                me.start();
            }
        }
        me.requireCount = me.requires.length;
        if (me.requireCount == 0) {
            me.requireCount = 1;
            load();
            return;
        }
        for (const src of me.requires) {
            if (!src || resourceLoader.isLoaded(src)) {
                load();
                continue;
            }
            resourceLoader.loadScript(src, load);
        }
    }
    /**
     * Read the app script URL from <meta name="boot" content="...">.
     * Falls back to "/typescript/build/app.js" when not found.
     * @internal
     */
    app() {
        var _a;
        const metas = document.getElementsByTagName("meta");
        for (let i = 0; i < metas.length; i++) {
            const meta = metas[i];
            if (meta.getAttribute("name") == "boot")
                return (_a = meta.getAttribute("content")) !== null && _a !== void 0 ? _a : "";
        }
        return "/typescript/build/app.js";
    }
    /** @internal */
    constructor() {
        /** @internal */
        this.included = false;
        /** @internal */
        this.loaded = false;
        /** @internal */
        this.moduleCount = 0;
        /** @internal */
        this.modules = [];
        /** @internal */
        this.requireCount = 0;
        /** @internal */
        this.requires = [];
        if (window["boot"])
            return;
        const me = this;
        window["boot"] = me;
        me.processIncludes();
        window.addEventListener("DOMContentLoaded", () => {
            resourceLoader.loadScript(me.app(), () => me.processUses());
        });
    }
    /**
     * Fetch a text resource asynchronously.
     * @param url The URL to fetch.
     * @param onload Callback receiving the response text and optional state.
     * @param state Optional state passed through to the callback.
     */
    open(url, onload, state) {
        const request = new XMLHttpRequest();
        request.open("GET", url, true);
        request.onload = () => {
            onload(request.response, state);
        };
        request.send();
    }
    /**
     * Register a script to be loaded during the requires phase.
     * Duplicate URLs are ignored.
     * @param script The URL of the script to load.
     */
    require(script) {
        if (this.requires.indexOf(script) < 0)
            this.requires.push(script);
    }
    /**
     * Register one or more CDN modules to be loaded during the uses phase.
     * Duplicate module names are ignored.
     * @param module A single module name or an array of module names.
     */
    use(module) {
        const items = Array.isArray(module) ? module : [module];
        for (const item of items)
            if (this.modules.indexOf(item) < 0)
                this.modules.push(item);
    }
}
new Boot();
//# sourceMappingURL=boot.js.map