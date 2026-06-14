/** The category of failure reported by a WebRequest. */
enum WebRequestErrorKind {
    /** No error occured. */
    None = "none",
    /** The server responded with a status code outside the 200-299 range. */
    Status = "status",
    /** The request exceeded its time budget before completing. */
    Timeout = "timeout",
    /** A transport/connection level failure occured (dns, offline, cors etc). */
    Network = "network",
    /** The request was cancelled by the caller or superseded by a newer request. */
    Aborted = "aborted",
    /** The response body could not be interpreted (for example invalid JSON). */
    Parse = "parse"
}

/** Describes why a WebRequest failed. */
interface WebRequestError {
    /** The category of the failure. */
    kind: WebRequestErrorKind;
    /** The http status code associated with the failure, or 0 when not applicable. */
    status: number;
    /** A human readable description suitable for surfacing to a user. */
    message: string;
}

/** Configuration accepted by WebRequest.send and WebRequest.post. */
interface WebRequestOptions {
    /** Notification invoked after the request completes successfully. */
    onsuccess?: WebRequestCallback;
    /** Notification invoked when the request fails (status, network or, when no
     * timeout handler is supplied, timeout failures). */
    onerror?: WebRequestCallback;
    /** Notification invoked specifically when the request times out. */
    ontimeout?: WebRequestCallback;
    /** How long a successful response may be reused. A number is a lifetime in
     * milliseconds, true caches forever and false/0 disables caching. */
    cache?: number | boolean;
    /** When true any cached copy is ignored and a fresh request is made. The
     * fresh response still refreshes the cache. */
    refresh?: boolean;
    /** Milliseconds to wait before aborting the request as a timeout. 0 disables. */
    timeout?: number;
    /** Additional request headers to send. */
    headers?: { [name: string]: string };
    /** The format of data expected as a result. */
    requestType?: XMLHttpRequestResponseType;
}

/** A single cached response together with the moment it stops being valid. */
interface CacheEntry {
    value: string;
    expires: number;
}

/** LocalCache is used by the WebRequest object to capture responses. Each entry
 * carries an expiry so stale responses are not handed back indefinitely. */
class LocalCache {
    private data: { [url: string]: CacheEntry } = {};

    private isFresh(url: string): boolean {
        let entry = this.data[url];
        if (!isDefined(entry))
            return false;
        return entry.expires === Infinity || entry.expires > Date.now();
    }

    /** Remove a single cached entry. */
    remove(url: string): void {
        delete this.data[url];
    }

    /** Remove every cached entry. */
    clear(): void {
        this.data = {};
    }

    /** Returns true when a non expired entry exists for the url. Expired entries
     * are evicted as a side effect so they do not accumulate. */
    exists(url: string): boolean {
        if (this.isFresh(url))
            return true;
        if (this.data.hasOwnProperty(url))
            delete this.data[url];
        return false;
    }

    /** Returns the cached value for a url, or undefined when missing or expired. */
    recall(url: string): string {
        return this.isFresh(url) ? this.data[url].value : undefined;
    }

    /** Store a value against a url.
     * @param url The endpoint the value was retrieved from.
     * @param value The response text to remember.
     * @param ttl Lifetime in milliseconds. Defaults to forever; a value of 0 or
     * less is treated as "do not cache".
     */
    store(url: string, value: string, ttl: number = Infinity): void {
        if (ttl <= 0)
            return;
        let expires = ttl === Infinity ? Infinity : Date.now() + ttl;
        this.data[url] = { value: value, expires: expires };
    }
}

/** WebRequest handles asynchronous http 'get' and 'post' requests. */
class WebRequest {
    /** Responses are cached here so one off helpers benefit from caching too. */
    private static sharedCache = new LocalCache();

    private httpRequest: XMLHttpRequest;
    private cacheTtl: number = 0;
    private refresh: boolean = false;
    private timeoutMs: number = 0;
    private headers: { [name: string]: string } = null;
    private successCallback: WebRequestCallback;
    private errorCallback: WebRequestCallback;
    private timeoutCallback: WebRequestCallback;
    private lastError: WebRequestError = webRequestError(WebRequestErrorKind.None);

    private clearResponse() {
        this.responseText = undefined;
        this.responseBytes = undefined;
        this.responseXML = undefined;
        this.lastError = webRequestError(WebRequestErrorKind.None);
    }

    private sendComplete(data?: string) {
        if (this.requestType == "arraybuffer" || this.requestType == "blob")
            this.responseBytes = new Uint8Array(this.httpRequest.response);
        else if (this.requestType == "document")
            this.responseXML = this.httpRequest.responseXML;
        else {
            if (isDefined(data))
                this.responseText = data;
            else
                this.responseText = this.httpRequest.responseText;
            if (this.cacheTtl > 0)
                WebRequest.sharedCache.store(this.url, this.responseText, this.cacheTtl);
        }
        if (this.successCallback)
            this.successCallback(this);
    }

    private fail(error: WebRequestError) {
        this.lastError = error;
        if (error.kind == WebRequestErrorKind.Timeout && this.timeoutCallback)
            this.timeoutCallback(this);
        else if (this.errorCallback)
            this.errorCallback(this);
    }

    private httpRequestLoad() {
        let code = this.httpRequest.status;
        if (code > 199 && code < 300)
            this.sendComplete();
        else
            this.fail(webRequestError(WebRequestErrorKind.Status, code));
    }

    private httpRequestError() {
        this.fail(webRequestError(WebRequestErrorKind.Network, this.httpRequest.status));
    }

    private httpRequestTimeout() {
        this.fail(webRequestError(WebRequestErrorKind.Timeout, this.httpRequest.status));
    }

    /** @param requestType The format of data expected as a result.
     *  @param xhrFactory Optional factory used to create the underlying request.
     *  Supplying one allows the transport to be substituted (for example in tests).
     */
    constructor(requestType: XMLHttpRequestResponseType = "text", xhrFactory?: Func<XMLHttpRequest>) {
        this.requestType = requestType;
        this.httpRequest = isDefined(xhrFactory) ? xhrFactory() : new XMLHttpRequest();
        this.httpRequest.responseType = requestType;
        this.httpRequest.onload = () => this.httpRequestLoad();
        this.httpRequest.onerror = () => this.httpRequestError();
        this.httpRequest.ontimeout = () => this.httpRequestTimeout();
        this.successCallback = null;
        this.errorCallback = null;
        this.timeoutCallback = null;
    }

    public set onsuccess(handler: WebRequestCallback) {
        this.successCallback = handler;
    }

    public set onerror(handler: WebRequestCallback) {
        this.errorCallback = handler;
    }

    public set ontimeout(handler: WebRequestCallback) {
        this.timeoutCallback = handler;
    }

    public get status(): number {
        return this.httpRequest.status;
    }

    /** Details of the most recent failure, or a None error when the last
     * request succeeded. */
    public get error(): WebRequestError {
        return this.lastError;
    }

    /** True when the last request completed without an error. */
    public get ok(): boolean {
        return this.lastError.kind == WebRequestErrorKind.None;
    }

    /** Remove every cached response shared across WebRequest instances. */
    public static clearCache(): void {
        WebRequest.sharedCache.clear();
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

    /** After send completes successfully the response parsed as a javascript
     * object. Returns undefined when the body is not valid JSON rather than
     * throwing, so a malformed response cannot break the calling flow. */
    get responseJSON(): any {
        let [ok, value] = tryParseJson(this.responseText);
        return ok ? value : undefined;
    }

    /** Try to read the response body as JSON without throwing.
     * @returns A tuple of [ok, value]; ok is false and value is undefined when
     * the body is missing or not valid JSON.
     */
    tryJson(): [boolean, any] {
        return tryParseJson(this.responseText);
    }

    private applyOptions(options: WebRequestOptions) {
        options = isDefined(options) ? options : {};
        if (isDefined(options.requestType) && options.requestType != this.requestType) {
            this.requestType = options.requestType;
            this.httpRequest.responseType = options.requestType;
        }
        this.successCallback = isDefined(options.onsuccess) ? options.onsuccess : null;
        this.errorCallback = isDefined(options.onerror) ? options.onerror : null;
        this.timeoutCallback = isDefined(options.ontimeout) ? options.ontimeout : null;
        this.cacheTtl = webRequestCacheTtl(options.cache);
        this.refresh = options.refresh === true;
        this.timeoutMs = isNumber(options.timeout) && options.timeout > 0 ? options.timeout : 0;
        this.headers = isDefined(options.headers) ? options.headers : null;
    }

    private dispatch(method: string, url: string, body?: FormData | String | Object) {
        this.httpRequest.abort();
        this.clearResponse();
        this.url = url;
        if (this.cacheTtl > 0 && !this.refresh && WebRequest.sharedCache.exists(url)) {
            this.sendComplete(WebRequest.sharedCache.recall(url));
            return;
        }
        this.httpRequest.open(method, url);
        this.httpRequest.timeout = this.timeoutMs;
        if (isDefined(this.headers))
            for (let name of Object.keys(this.headers))
                this.httpRequest.setRequestHeader(name, this.headers[name]);
        if (isUndefined(body))
            this.httpRequest.send();
        else if (body instanceof FormData || isString(body))
            this.httpRequest.send(body as any);
        else
            this.httpRequest.send(objectToFormData(body));
    }

    /** Normalise the overloaded send/post arguments into an options object. */
    private static toOptions(a: WebRequestCallback | WebRequestOptions,
        onerror: WebRequestCallback, cache: number | boolean): WebRequestOptions {
        if (typeof a === "function" || isUndefined(a))
            return { onsuccess: a as WebRequestCallback, onerror: onerror, cache: cache };
        return a;
    }

    /** Perform an asynchronous http get request.
     * @param url The endpoint for the requested resource.
     * @param options Request configuration (callbacks, cache, timeout, headers).
     */
    send(url: string, options?: WebRequestOptions): void;
    /** Perform an asynchronous http get request.
     * @param url The endpoint for the requested resource.
     * @param onsuccess Your notification invoked after request completes successfully.
     * @param onerror Your notification invoked when the request fails.
     * @param cache When set responses are reused for each distinct url. A number
     * is a lifetime in milliseconds; true caches forever.
     */
    send(url: string, onsuccess?: WebRequestCallback, onerror?: WebRequestCallback, cache?: number | boolean): void;
    send(url: string, a?: WebRequestCallback | WebRequestOptions, onerror?: WebRequestCallback, cache?: number | boolean): void {
        this.applyOptions(WebRequest.toOptions(a, onerror, cache));
        this.dispatch("GET", url);
    }

    /** Perform an asynchronous http post request.
     * @param url The endpoint for the requested resource.
     * @param data Data posted to the recipient endpoint.
     * @param options Request configuration (callbacks, cache, timeout, headers).
     */
    post(url: string, data: FormData | String | Object, options?: WebRequestOptions): void;
    /** Perform an asynchronous http post request.
     * @param url The endpoint for the requested resource.
     * @param data Data posted to the recipient endpoint.
     * @param onsuccess Your notification invoked after request completes successfully.
     * @param onerror Your notification invoked when the request fails.
     * @param cache When set responses are reused for each distinct url.
     */
    post(url: string, data: FormData | String | Object, onsuccess?: WebRequestCallback,
        onerror?: WebRequestCallback, cache?: number | boolean): void;
    post(url: string, data: FormData | String | Object, a?: WebRequestCallback | WebRequestOptions,
        onerror?: WebRequestCallback, cache?: number | boolean): void {
        this.applyOptions(WebRequest.toOptions(a, onerror, cache));
        this.dispatch("POST", url, data);
    }

    /** Cancel any pending send or post operations. */
    cancel(): void {
        this.httpRequest.abort();
        this.lastError = webRequestError(WebRequestErrorKind.Aborted, this.httpRequest.status);
    }
}

/** RequestCallback is the type used to notify you when send completes. */
type WebRequestCallback = (request: WebRequest) => void;

/** Convert a cache option into a lifetime in milliseconds.
 * @param cache true (forever), a number of milliseconds, or false/undefined (off).
 * @returns The lifetime in milliseconds; 0 means caching is disabled.
 */
function webRequestCacheTtl(cache: number | boolean): number {
    if (cache === true)
        return Infinity;
    if (isNumber(cache) && cache > 0)
        return cache;
    return 0;
}

/** Build a WebRequestError, filling in a default message when none is given. */
function webRequestError(kind: WebRequestErrorKind, status: number = 0, message?: string): WebRequestError {
    return {
        kind: kind,
        status: status,
        message: isDefined(message) ? message : webRequestErrorMessage(kind, status)
    };
}

/** Produce a human readable message for an error kind. */
function webRequestErrorMessage(kind: WebRequestErrorKind, status: number): string {
    switch (kind) {
        case WebRequestErrorKind.Status: return `The request failed with status ${status}.`;
        case WebRequestErrorKind.Timeout: return "The request timed out.";
        case WebRequestErrorKind.Network: return "A network error occured.";
        case WebRequestErrorKind.Aborted: return "The request was cancelled.";
        case WebRequestErrorKind.Parse: return "The response could not be read.";
        default: return "No error.";
    }
}

/** Parse a string as JSON without throwing.
 * @param text The string to parse.
 * @returns A tuple of [ok, value]; ok is false and value is undefined when text
 * is missing or not valid JSON.
 */
function tryParseJson(text: string): [boolean, any] {
    if (isUndefined(text))
        return [false, undefined];
    try {
        return [true, JSON.parse(text)];
    } catch (e) {
        return [false, undefined];
    }
}

/** Combine an explicit success/error callback with an options object. The
 * positional callbacks win so the historic helper signatures keep working. */
function webRequestOptions(options: WebRequestOptions, onsuccess?: WebRequestCallback,
    onerror?: WebRequestCallback): WebRequestOptions {
    let source = isDefined(options) ? options : {};
    return {
        onsuccess: isDefined(onsuccess) ? onsuccess : source.onsuccess,
        onerror: isDefined(onerror) ? onerror : source.onerror,
        ontimeout: source.ontimeout,
        cache: source.cache,
        refresh: source.refresh,
        timeout: source.timeout,
        headers: source.headers,
        requestType: source.requestType
    };
}

/** Perform a one off asynchronous http get request.
 * @param url The endpoint for the requested resource.
 * @param onsuccess Optional notification invoked when the request loads.
 * @param onerror Optional notification invoked when the request fails.
 * @param options Optional configuration such as cache, timeout and headers.
 */
function sendWebRequest(url: string, onsuccess?: WebRequestCallback, onerror?: WebRequestCallback,
    options?: WebRequestOptions) {
    let opts = webRequestOptions(options, onsuccess, onerror);
    let r = new WebRequest(getDefault(opts.requestType, "text"));
    r.send(url, opts);
}

/** Perform a one off asynchronous http get request.
 * @param url The endpoint for the requested resource.
 * @param requestType The type of data requested.
 * @param onsuccess Optional notification invoked when the request loads.
 * @param onerror Optional notification invoked when the request fails.
 * @param options Optional configuration such as cache, timeout and headers.
 */
function sendWebRequestType(url: string, requestType: XMLHttpRequestResponseType,
    onsuccess?: WebRequestCallback, onerror?: WebRequestCallback, options?: WebRequestOptions) {
    let opts = webRequestOptions(options, onsuccess, onerror);
    opts.requestType = requestType;
    let r = new WebRequest(requestType);
    r.send(url, opts);
}

/** Perform a one off asynchronous http post request.
 * @param url The endpoint for the requested resource.
 * @param data A string or object posted to the endpoint.
 * @param onsuccess Optional notification invoked when the request loads.
 * @param onerror Optional notification invoked when the request fails.
 * @param options Optional configuration such as cache, timeout and headers.
 */
function postWebRequest(url: string, data: FormData | String | Object,
    onsuccess?: WebRequestCallback, onerror?: WebRequestCallback, options?: WebRequestOptions) {
    let opts = webRequestOptions(options, onsuccess, onerror);
    let r = new WebRequest(getDefault(opts.requestType, "text"));
    r.post(url, data, opts);
}

/** Perform a one off asynchronous http post request.
 * @param url The endpoint for the requested resource.
 * @param data A string or object posted to the endpoint.
 * @param requestType The type of data requested.
 * @param onsuccess Optional notification invoked when the request loads.
 * @param onerror Optional notification invoked when the request fails.
 * @param options Optional configuration such as cache, timeout and headers.
 */
function postWebRequestType(url: string, data: FormData | String | Object,
    requestType: XMLHttpRequestResponseType, onsuccess?: WebRequestCallback,
    onerror?: WebRequestCallback, options?: WebRequestOptions) {
    let opts = webRequestOptions(options, onsuccess, onerror);
    opts.requestType = requestType;
    let r = new WebRequest(requestType);
    r.post(url, data, opts);
}

/** Returns true when a value is a Blob or File and should be appended verbatim. */
function isBlobLike(value: any): boolean {
    return typeof Blob !== "undefined" && value instanceof Blob;
}

/** Append a single value to a FormData object, expanding arrays and nested
 * objects and normalising booleans, dates and empty values.
 * @param data The FormData object being populated.
 * @param key The field name for the value.
 * @param value The value to append.
 */
function appendFormValue(data: FormData, key: string, value: any): void {
    if (isUndefined(value))
        return;
    if (isArray(value)) {
        for (let item of value as any[])
            appendFormValue(data, key, item);
        return;
    }
    if (isBoolean(value)) {
        data.append(key, value ? "true" : "false");
        return;
    }
    if (value instanceof Date) {
        data.append(key, value.toISOString());
        return;
    }
    if (isBlobLike(value)) {
        data.append(key, value);
        return;
    }
    if (isNumber(value)) {
        data.append(key, String(value));
        return;
    }
    if (isString(value)) {
        data.append(key, value as string);
        return;
    }
    if (isObject(value)) {
        for (let childKey of Object.keys(value))
            appendFormValue(data, `${key}[${childKey}]`, value[childKey]);
        return;
    }
    data.append(key, String(value));
}

/** Copies an object's enumerable properties into a FormData object. Arrays are
 * expanded into repeated fields, nested objects use bracketed keys, booleans and
 * dates are serialised predictably and null/undefined values are skipped.
 * @param obj An object with enumerable properties.
 * @returns A FormData object populated with values, or undefined when obj is null.
 */
function objectToFormData(obj: Object): FormData {
    if (isUndefined(obj))
        return undefined;
    let data = new FormData();
    for (let key of Object.keys(obj))
        appendFormValue(data, key, (obj as any)[key]);
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
