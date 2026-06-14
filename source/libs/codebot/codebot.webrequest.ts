/**
 * Classification of request failure types.
 * Used by WebRequestError to distinguish between different failure scenarios.
 */
enum WebRequestErrorType {
    /** The server responded with a non-2xx HTTP status code. */
    HttpStatus = "httpStatus",
    /** The request timed out before receiving a response. */
    Timeout = "timeout",
    /** A network-level error occurred (DNS failure, connection refused, CORS, etc). */
    Network = "network",
    /** The request was explicitly cancelled via WebRequest.cancel(). */
    Aborted = "aborted"
}

/**
 * Describes a request failure with enough detail for the caller to decide
 * how to present the error to the user.
 */
class WebRequestError {
    /** The category of failure. */
    type: WebRequestErrorType;

    /** The HTTP status code (only meaningful when type is HttpStatus). */
    status: number;

    /** The HTTP status text (only meaningful when type is HttpStatus). */
    statusText: string;

    /** A human-readable summary of the error. */
    message: string;

    constructor(type: WebRequestErrorType, status: number = 0, statusText: string = "") {
        this.type = type;
        this.status = status;
        this.statusText = statusText;
        switch (type) {
            case WebRequestErrorType.HttpStatus:
                this.message = `HTTP ${status} ${statusText}`;
                break;
            case WebRequestErrorType.Timeout:
                this.message = "Request timed out";
                break;
            case WebRequestErrorType.Network:
                this.message = "Network error";
                break;
            case WebRequestErrorType.Aborted:
                this.message = "Request was cancelled";
                break;
        }
    }
}

/**
 * Optional configuration for a web request.
 * All fields are optional so callers can pass a partial object.
 */
interface WebRequestOptions {
    /**
     * Controls response caching.
     * - `true`: cache indefinitely (until the WebRequest instance is discarded).
     * - A number: cache for that many milliseconds before re-fetching.
     * - `false` or `undefined`: no caching.
     */
    cache?: boolean | number;

    /** When true, ignore any cached value and always perform a fresh network request. */
    bypassCache?: boolean;

    /** Request timeout in milliseconds. 0 or undefined means no timeout. */
    timeout?: number;

    /** Additional HTTP headers to include with the request. */
    headers?: { [key: string]: string };
}

/** A cache entry with an optional expiration timestamp. */
interface CacheEntry {
    value: string;
    /** Epoch ms when this entry expires. 0 means never. */
    expires: number;
}

/** LocalCache stores responses keyed by URL with optional TTL expiration. */
class LocalCache {
    private data: { [key: string]: CacheEntry } = {};

    /** Remove a specific entry by url. */
    remove(url: string): void {
        delete this.data[url];
    }

    /** Returns true if a non-expired entry exists for the given url. */
    exists(url: string): boolean {
        if (!this.data.hasOwnProperty(url))
            return false;
        let entry = this.data[url];
        if (isUndefined(entry))
            return false;
        if (entry.expires > 0 && Date.now() > entry.expires) {
            delete this.data[url];
            return false;
        }
        return true;
    }

    /** Retrieve the cached value for a url. Returns undefined if missing or expired. */
    recall(url: string): string {
        if (!this.exists(url))
            return undefined;
        return this.data[url].value;
    }

    /**
     * Store a value in the cache.
     * @param url The cache key.
     * @param value The string to cache.
     * @param ttlMs Optional time-to-live in milliseconds. 0 or undefined means no expiration.
     */
    store(url: string, value: string, ttlMs?: number): void {
        let expires = (ttlMs && ttlMs > 0) ? Date.now() + ttlMs : 0;
        this.data[url] = { value: value, expires: expires };
    }

    /** Remove all cached entries. */
    clear(): void {
        this.data = {};
    }
}

/** WebRequest handles asynchronous http 'get' and 'post' requests. */
class WebRequest {
    private localCache: LocalCache;
    private httpRequest: XMLHttpRequest;
    private cacheOption: boolean | number;
    private succcessCallback: WebRequestCallback;
    private errorCallback: WebRequestCallback;
    private _error: WebRequestError;
    private _cancelled: boolean;

    private sendComplete(data?: string) {
        this.responseText = undefined;
        this.responseBytes = undefined;
        this._error = undefined;
        if (this.requestType == "arraybuffer" || this.requestType == "blob")
            this.responseBytes = new Uint8Array(this.httpRequest.response);
        else if (this.requestType == "document")
            this.responseXML = this.httpRequest.responseXML;
        else {
            if (data)
                this.responseText = data;
            else
                this.responseText = this.httpRequest.responseText;
            if (this.cacheOption) {
                let ttl = isNumber(this.cacheOption) ? this.cacheOption as number : undefined;
                this.localCache.store(this.url, this.responseText, ttl);
            }
        }
        if (this.succcessCallback)
            this.succcessCallback(this);
    }

    private failWithError(error: WebRequestError) {
        this._error = error;
        if (this.errorCallback)
            this.errorCallback(this);
    }

    private httpRequestLoad() {
        let code = this.httpRequest.status;
        if (code > 199 && code < 300)
            this.sendComplete();
        else
            this.failWithError(new WebRequestError(
                WebRequestErrorType.HttpStatus,
                code,
                this.httpRequest.statusText
            ));
    }

    private httpRequestError() {
        if (this._cancelled) {
            this.failWithError(new WebRequestError(WebRequestErrorType.Aborted));
        } else {
            this.failWithError(new WebRequestError(WebRequestErrorType.Network));
        }
    }

    private httpRequestTimeout() {
        this.failWithError(new WebRequestError(WebRequestErrorType.Timeout));
    }

    private httpRequestAbort() {
        if (this._cancelled)
            this.failWithError(new WebRequestError(WebRequestErrorType.Aborted));
    }

    private applyHeaders(headers?: { [key: string]: string }) {
        if (!headers)
            return;
        let keys = Object.keys(headers);
        for (let k of keys)
            this.httpRequest.setRequestHeader(k, headers[k]);
    }

    private resolveCacheTtl(cache?: boolean | number): number | undefined {
        if (isNumber(cache))
            return cache as number;
        return undefined;
    }

    constructor(requestType: XMLHttpRequestResponseType = "text") {
        this.requestType = requestType;
        this.localCache = new LocalCache();
        this.httpRequest = new XMLHttpRequest();
        this.httpRequest.responseType = requestType;
        this.httpRequest.onload = () => this.httpRequestLoad();
        this.httpRequest.onerror = () => this.httpRequestError();
        this.httpRequest.ontimeout = () => this.httpRequestTimeout();
        this.httpRequest.onabort = () => this.httpRequestAbort();
        this.succcessCallback = null;
        this.errorCallback = null;
        this._error = undefined;
        this._cancelled = false;
    }

    public set onsuccess(handler: WebRequestCallback) {
        this.succcessCallback = handler;
    }

    public set onerror(handler: WebRequestCallback) {
        this.errorCallback = handler;
    }

    public get status(): number {
        return this.httpRequest.status;
    }

    /** After a failed request, contains the error details. Undefined on success. */
    public get error(): WebRequestError {
        return this._error;
    }

    /** The endpoint of the last send or post operation. */
    url: string;

    /** The format of data expected as a result */
    requestType: XMLHttpRequestResponseType;

    /** After send completes successfully the response in a byte array. */
    responseBytes: Uint8Array;

    /** After send completes successfully the response in a string. */
    responseText: string;

    /** After send completes successfully the response in an XML document. */
    responseXML: Document;

    /**
     * Safely parse responseText as JSON.
     * Returns the parsed object on success, or undefined if the text is not valid JSON.
     * Unlike the raw JSON.parse, this will not throw.
     */
    get responseJSON(): any {
        if (isUndefined(this.responseText))
            return undefined;
        try {
            return JSON.parse(this.responseText);
        } catch (e) {
            return undefined;
        }
    }

    /** Access the underlying cache for manual inspection or clearing. */
    get cache(): LocalCache {
        return this.localCache;
    }

    /** Perform an asynchronous http get request.
     * @param url The endpoint for the requested resource.
     * @param onsuccess Your notification invoked after request completes successfully.
     * @param onerror Your notification invoked if the request fails.
     * @param cache Controls caching: true caches indefinitely, a number caches for that many ms, false disables.
     * @param options Additional request configuration (timeout, headers, bypassCache).
     */
    send(url: string, onsuccess?: WebRequestCallback, onerror?: WebRequestCallback,
        cache?: boolean | number, options?: WebRequestOptions): void {
        this.httpRequest.abort();
        this._cancelled = false;
        this.url = url;
        this.succcessCallback = onsuccess;
        this.errorCallback = onerror;
        this.cacheOption = cache;

        // Merge options
        let bypassCache = options && options.bypassCache;
        if (options && isDefined(options.cache))
            this.cacheOption = options.cache;

        // Check cache (unless bypassing)
        if (!bypassCache && this.cacheOption && this.localCache.exists(url)) {
            this.sendComplete(this.localCache.recall(url));
            return;
        }

        this.httpRequest.open("GET", url);
        if (options && options.timeout)
            this.httpRequest.timeout = options.timeout;
        this.applyHeaders(options ? options.headers : undefined);
        this.httpRequest.send();
    }

    /** Perform an asynchronous http post request.
     * @param url The endpoint for the requested resource.
     * @param data Data posted to recipient enpoint.
     * @param onsuccess Your notification invoked after request completes successfully.
     * @param onerror Your notification invoked if the request fails.
     * @param cache Controls caching: true caches indefinitely, a number caches for that many ms, false disables.
     * @param options Additional request configuration (timeout, headers, bypassCache).
     */
    post(url: string, data: FormData | String | Object, onsuccess?: WebRequestCallback,
        onerror?: WebRequestCallback, cache?: boolean | number, options?: WebRequestOptions): void {
        this.httpRequest.abort();
        this._cancelled = false;
        this.url = url;
        this.succcessCallback = onsuccess;
        this.errorCallback = onerror;
        this.cacheOption = cache;

        // Merge options
        let bypassCache = options && options.bypassCache;
        if (options && isDefined(options.cache))
            this.cacheOption = options.cache;

        // Check cache (unless bypassing)
        if (!bypassCache && this.cacheOption && this.localCache.exists(url)) {
            this.sendComplete(this.localCache.recall(url));
            return;
        }

        this.httpRequest.open("POST", url);
        if (options && options.timeout)
            this.httpRequest.timeout = options.timeout;
        this.applyHeaders(options ? options.headers : undefined);

        if (data instanceof FormData || isString(data))
            this.httpRequest.send(data);
        else
            this.httpRequest.send(objectToFormData(data));
    }

    /** Cancel any pending send or post operations. */
    cancel(): void {
        this._cancelled = true;
        this.httpRequest.abort();
    }
}

/** RequestCallback is the type used to notify you when send completes successfully. */
type WebRequestCallback = (request: WebRequest) => void;

/** Perform a one off asynchronous http get request.
 * @param url The endpoint for the requested resource.
 * @param onsuccess Optional notification invoked when the request loads.
 * @param onerror Optional notification invoked when the request fails.
 * @param options Optional request configuration.
 */
function sendWebRequest(url: string, onsuccess?: WebRequestCallback,
    onerror?: WebRequestCallback, options?: WebRequestOptions) {
    let r = new WebRequest();
    let cache = options ? options.cache : undefined;
    r.send(url, onsuccess, onerror, cache, options);
}

/** Perform a one off asynchronous http get request.
 * @param url The endpoint for the requested resource.
 * @param requestType The type of data requested.
 * @param onsuccess Optional notification invoked when the request loads.
 * @param onerror Optional notification invoked when the request fails.
 * @param options Optional request configuration.
 */
function sendWebRequestType(url: string, requestType: XMLHttpRequestResponseType,
    onsuccess?: WebRequestCallback, onerror?: WebRequestCallback, options?: WebRequestOptions) {
    let r = new WebRequest(requestType);
    let cache = options ? options.cache : undefined;
    r.send(url, onsuccess, onerror, cache, options);
}

/** Perform a one off asynchronous http post request.
 * @param url The endpoint for the requested resource.
 * @param data A string or object posted to the enpoint.
 * @param onsuccess Optional notification invoked when the request loads.
 * @param onerror Optional notification invoked when the request fails.
 * @param options Optional request configuration.
 */
function postWebRequest(url: string, data: FormData | String | Object,
    onsuccess?: WebRequestCallback, onerror?: WebRequestCallback, options?: WebRequestOptions) {
    let r = new WebRequest();
    let cache = options ? options.cache : undefined;
    r.post(url, data, onsuccess, onerror, cache, options);
}

/** Perform a one off asynchronous http post request.
 * @param url The endpoint for the requested resource.
 * @param data A string or object posted to the enpoint.
 * @param requestType The type of data requested.
 * @param onsuccess Optional notification invoked when the request loads.
 * @param onerror Optional notification invoked when the request fails.
 * @param options Optional request configuration.
 */
function postWebRequestType(url: string, data: FormData | String | Object,
    requestType: XMLHttpRequestResponseType, onsuccess?: WebRequestCallback,
    onerror?: WebRequestCallback, options?: WebRequestOptions) {
    let r = new WebRequest(requestType);
    let cache = options ? options.cache : undefined;
    r.post(url, data, onsuccess, onerror, cache, options);
}

/**
 * Convert a plain object into a FormData instance with proper handling of
 * common value types:
 * - Strings and numbers are appended directly.
 * - Booleans are converted to "true" or "false".
 * - Arrays produce multiple entries with the same key.
 * - null and undefined values are skipped.
 * - Blob and File objects are passed through.
 * - Other objects are serialized as JSON strings.
 *
 * @param obj An object with enumerable properties.
 * @returns A FormData object populated with values, or undefined if obj is undefined/null.
 */
function objectToFormData(obj: Object): FormData {
    if (obj == undefined)
        return undefined;
    let data = new FormData();
    let keys = Object.keys(obj);
    for (let k of keys) {
        let value = obj[k];

        // Skip null and undefined
        if (value === null || value === undefined)
            continue;

        // Arrays: append each element with the same key
        if (isArray(value)) {
            let arr = value as any[];
            for (let i = 0; i < arr.length; i++) {
                let item = arr[i];
                if (item === null || item === undefined)
                    continue;
                if (item instanceof Blob)
                    data.append(k, item);
                else if (isObject(item) && !(item instanceof Blob))
                    data.append(k, JSON.stringify(item));
                else
                    data.append(k, String(item));
            }
            continue;
        }

        // Blob / File: pass through
        if (value instanceof Blob) {
            data.append(k, value);
            continue;
        }

        // Booleans: explicit string
        if (isBoolean(value)) {
            data.append(k, value ? "true" : "false");
            continue;
        }

        // Numbers and strings: direct append
        if (isString(value) || isNumber(value)) {
            data.append(k, String(value));
            continue;
        }

        // Other objects (Date, plain objects, etc): JSON serialize
        if (value instanceof Date) {
            data.append(k, value.toISOString());
            continue;
        }
        if (isObject(value)) {
            data.append(k, JSON.stringify(value));
            continue;
        }

        // Fallback: coerce to string
        data.append(k, String(value));
    }
    return data;
}

/** Perform a sumbit of a form using an XMLHttpRequest
 * @param form The HTMLFormElelemnt to submit.
 * @param prepare An option callback to prepare the request before it's sent.
 * @return The XMLHttpRequest object already sent.
 */
function formSubmit(form: HTMLFormElement, prepare?: Action<XMLHttpRequest>): XMLHttpRequest {
    let formData = new FormData(form);
    let request = new XMLHttpRequest();
    if (prepare)
        prepare(request);
    request.open(form.getAttribute("method"), form.getAttribute("action"), true);
    request.send(formData);
    return request;
}
