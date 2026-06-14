/// <reference path="boot.resource.ts" />

interface Window {
    [key: string]: any;
}

type QuerySelect = string | HTMLElement | Array<HTMLElement>;

function get(query: QuerySelect): HTMLElement {
    if (typeof query == "string")
        return document.querySelector(query) as HTMLElement;
    if (query instanceof HTMLElement)
        return query;
    return query[0];
}

function getAll(query: QuerySelect): Array<HTMLElement> {
    if (typeof query == "string") {
        let nodes: any = document.querySelectorAll(query);
        return Array.prototype.slice.call(nodes);
    }
    if (query instanceof HTMLElement)
        return [query];
    return query;
}

interface HTMLElement {
    get(query: QuerySelect): HTMLElement;
    getAll(query: QuerySelect): Array<HTMLElement>;
}

HTMLElement.prototype.get = function (query: QuerySelect): HTMLElement {
    if (typeof query == "string")
        return this.querySelector(query) as HTMLElement;
    if (query instanceof HTMLElement)
        return query;
    return query[0];
}

HTMLElement.prototype.getAll = function (query: QuerySelect): Array<HTMLElement> {
    if (typeof query == "string") {
        let nodes: any = this.querySelectorAll(query);
        return Array.prototype.slice.call(nodes);
    }
    if (query instanceof HTMLElement)
        return [query];
    return query;
}

interface String {
    includes(search: string, start?: number): boolean;
    startsWith(searchString: string, position?: number): boolean;
    endsWith(searchString: string, position?: number): boolean;
}

if (!String.prototype.includes) {
    String.prototype.includes = function (search, start) {
        if (typeof start !== 'number') {
            start = 0;
        }
        if (start + search.length > this.length) {
            return false;
        } else {
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

type BootModule = "ace" | "greensock" | "jquery" | "rivets" | "three";

interface BootModuleEntry {
    readonly url: string;
    readonly identifier: string;
}

const BOOT_MODULE_ENTRIES: { [key: string]: BootModuleEntry } = {
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
    private included = false;
    /** @internal */
    private loaded = false;
    /** @internal */
    private moduleCount = 0;
    /** @internal */
    private modules: BootModule[] = [];
    /** @internal */
    private requireCount = 0;
    /** @internal */
    private requires: string[] = [];

    /** @internal */
    private start(): void {
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
    private processIncludes(): void {
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
    private processUses(): void {
        const me = this;
        const entries = BOOT_MODULE_ENTRIES;

        function load(): void {
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
    private processRequires(): void {
        const me = this;

        function load(): void {
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
    private app(): string {
        const metas = document.getElementsByTagName("meta");
        for (let i = 0; i < metas.length; i++) {
            const meta = metas[i];
            if (meta.getAttribute("name") == "boot")
                return meta.getAttribute("content") ?? "";
        }
        return "/typescript/build/app.js";
    }

    /** @internal */
    constructor() {
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
    open(url: string, onload: (result: string, state?: any) => void, state?: any): void {
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
    require(script: string): void {
        if (this.requires.indexOf(script) < 0)
            this.requires.push(script);
    }

    /**
     * Register one or more CDN modules to be loaded during the uses phase.
     * Duplicate module names are ignored.
     * @param module A single module name or an array of module names.
     */
    use(module: BootModule | Array<BootModule>): void {
        const items = Array.isArray(module) ? module : [module];
        for (const item of items)
            if (this.modules.indexOf(item) < 0)
                this.modules.push(item);
    }
}

declare var boot: Boot;

new Boot();
