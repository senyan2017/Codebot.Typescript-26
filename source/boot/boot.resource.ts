/**
 * Unified resource loader for the boot pipeline.
 *
 * Responsibility: loading scripts, stylesheets and HTML fragments with
 * deduplication.  Shared by the Boot startup sequencer (boot.ts) and
 * the runtime DOM helpers (codebot.dom.element.ts) so that both sides
 * see the same loaded-resource registry and never double-load a file.
 */

/** Supported resource kinds. */
type ResourceType = "script" | "stylesheet" | "text";

/** Per-entry record kept for every resource that was requested. */
interface ResourceEntry {
    readonly url: string;
    readonly type: ResourceType;
    loaded: boolean;
}

/** Callback signatures used throughout the resource pipeline. */
type ResourceLoadCallback = () => void;
type TextLoadCallback = (text: string) => void;

/**
 * Singleton that tracks every resource the page has requested and
 * exposes low-level loaders for scripts, stylesheets and text fragments.
 *
 * A global instance is created as `ResourceLoader` at script-eval time
 * (boot.js loads first, so it is available to both the boot sequencer
 * and the later app.js bundle).
 */
class ResourceLoader {

    /** Every URL that has been requested, keyed by url. */
    private registry: { [url: string]: ResourceEntry } = {};

    // ------------------------------------------------------------------
    //  Registry helpers
    // ------------------------------------------------------------------

    /** True when `url` has already been queued or loaded. */
    isLoaded(url: string): boolean {
        return this.registry.hasOwnProperty(url);
    }

    /** Mark a URL as seen (loaded = true). */
    markLoaded(url: string, type: ResourceType): void {
        this.registry[url] = { url: url, type: type, loaded: true };
    }

    /** Return a snapshot of every registered resource. */
    getEntries(): ResourceEntry[] {
        const out: ResourceEntry[] = [];
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
    loadScript(url: string, onload?: ResourceLoadCallback): void {
        if (this.isLoaded(url)) {
            if (onload) onload();
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
    loadStyleSheet(url: string, onload?: ResourceLoadCallback): void {
        if (this.isLoaded(url)) {
            if (onload) onload();
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
        if (head) head.appendChild(link);
    }

    /**
     * Fetch a text resource via XHR.  Deduplicates by URL so the same
     * fragment is not fetched twice during the include-processing pass.
     */
    loadText(url: string, onload: TextLoadCallback): void {
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
    processHtmlIncludes(oncomplete: ResourceLoadCallback): void {
        const self = this;

        function isWrongPlatform(el: HTMLElement): boolean {
            const target = el.getAttribute("target-platform");
            if (!target) return false;
            const isDesktop = typeof window.orientation === "undefined";
            return target === "mobile" ? isDesktop : !isDesktop;
        }

        function toElementArray(items: HTMLCollectionOf<Element>): HTMLElement[] {
            return Array.prototype.slice.call(items) as HTMLElement[];
        }

        const includes = toElementArray(document.getElementsByTagName("include"));
        let pending = includes.length;

        if (pending === 0) {
            oncomplete();
            return;
        }

        function tick(): void {
            pending--;
            if (pending === 0)
                self.processHtmlIncludes(oncomplete);
        }

        for (const item of includes) {
            const src = item.getAttribute("src");
            if (src === null) break;

            if (src.endsWith(".css")) {
                item.parentNode?.removeChild(item);
                if (self.isLoaded(src) || isWrongPlatform(item)) {
                    tick();
                    continue;
                }
                self.loadStyleSheet(src, tick);

            } else if (src.endsWith(".js")) {
                item.parentNode?.removeChild(item);
                if (self.isLoaded(src) || isWrongPlatform(item)) {
                    tick();
                    continue;
                }
                self.loadScript(src, tick);

            } else {
                const parent = item.parentNode;
                const next = item.nextSibling;
                parent?.removeChild(item);
                self.loadText(src, function (html: string): void {
                    const container = item;
                    container.innerHTML = html;
                    const children = toElementArray(container.children);
                    while (children.length) {
                        const node = children.shift();
                        if (node) parent?.insertBefore(node, next);
                    }
                    tick();
                });
            }
        }
    }
}

/** Global singleton — created once when boot.js evaluates. */
const resourceLoader = new ResourceLoader();
