/// <reference path="codebot.system.ts" />
/// <reference path="codebot.diagnostics.ts" />
/// <reference path="codebot.webrequest.ts" />

/** A reporter receives the outcome of a single assertion. */
type WebTestReport = (name: string, ok: boolean) => void;

/** A scriptable stand in for XMLHttpRequest used to drive WebRequest through its
 * full lifecycle without a real network. Only the surface WebRequest touches is
 * implemented. The outcome of send is programmed up front so behaviour is
 * deterministic. */
class FakeXhr {
    responseType: XMLHttpRequestResponseType = "text";
    status: number = 0;
    responseText: string = "";
    response: any = null;
    responseXML: any = null;
    timeout: number = 0;

    onload: () => void = null;
    onerror: () => void = null;
    ontimeout: () => void = null;

    /** Number of times send actually reached the transport. */
    sendCount = 0;
    lastMethod: string = null;
    lastUrl: string = null;
    lastBody: any = undefined;
    headers: { [name: string]: string } = {};

    /** "load" delivers status+body, "network" raises an error, "timeout" times out. */
    private outcome: "load" | "network" | "timeout" = "load";
    private loadStatus = 200;
    private loadBody = "";

    /** Program a successful (or status error) load. */
    programLoad(status: number, body: string): FakeXhr {
        this.outcome = "load";
        this.loadStatus = status;
        this.loadBody = body;
        return this;
    }

    /** Program a transport level failure. */
    programNetwork(): FakeXhr {
        this.outcome = "network";
        return this;
    }

    /** Program a timeout. */
    programTimeout(): FakeXhr {
        this.outcome = "timeout";
        return this;
    }

    open(method: string, url: string): void {
        this.lastMethod = method;
        this.lastUrl = url;
    }

    setRequestHeader(name: string, value: string): void {
        this.headers[name] = value;
    }

    abort(): void {
        // No active connection to tear down in the fake.
    }

    send(body?: any): void {
        this.sendCount++;
        this.lastBody = body;
        if (this.outcome == "network") {
            if (this.onerror) this.onerror();
            return;
        }
        if (this.outcome == "timeout") {
            if (this.ontimeout) this.ontimeout();
            return;
        }
        this.status = this.loadStatus;
        this.responseText = this.loadBody;
        this.response = this.loadBody;
        if (this.onload) this.onload();
    }
}

/** Helpers that build a WebRequest wired to a FakeXhr. */
function fakeRequest(fake: FakeXhr): WebRequest {
    return new WebRequest("text", () => fake as any as XMLHttpRequest);
}

/** Run a single assertion, treating any thrown error as a failure so one broken
 * case cannot abort the whole suite. */
function webTestCheck(report: WebTestReport, name: string, fn: () => boolean): void {
    let ok = false;
    try {
        ok = fn() === true;
    } catch (e) {
        ok = false;
    }
    report(name, ok);
}

/** Verify objectToFormData handles arrays, booleans, numbers, dates, nested
 * objects and empty values without "糊过去" the awkward cases. */
function webTestFormData(report: WebTestReport): void {
    webTestCheck(report, "formData expands arrays into repeated fields", () => {
        let fd = objectToFormData({ tags: ["a", "b", "c"] });
        let all = fd.getAll("tags");
        return all.length === 3 && all[0] === "a" && all[2] === "c";
    });
    webTestCheck(report, "formData serialises booleans as true/false", () => {
        let fd = objectToFormData({ active: true, hidden: false });
        return fd.get("active") === "true" && fd.get("hidden") === "false";
    });
    webTestCheck(report, "formData skips null and undefined values", () => {
        let fd = objectToFormData({ a: null, b: undefined, c: "keep" });
        return !fd.has("a") && !fd.has("b") && fd.get("c") === "keep";
    });
    webTestCheck(report, "formData keeps empty strings", () => {
        let fd = objectToFormData({ note: "" });
        return fd.has("note") && fd.get("note") === "";
    });
    webTestCheck(report, "formData stringifies numbers", () => {
        let fd = objectToFormData({ count: 42, zero: 0 });
        return fd.get("count") === "42" && fd.get("zero") === "0";
    });
    webTestCheck(report, "formData uses bracket keys for nested objects", () => {
        let fd = objectToFormData({ user: { name: "bob", age: 7 } });
        return fd.get("user[name]") === "bob" && fd.get("user[age]") === "7";
    });
    webTestCheck(report, "formData serialises dates as ISO strings", () => {
        let fd = objectToFormData({ when: new Date("2020-01-02T03:04:05.000Z") });
        return fd.get("when") === "2020-01-02T03:04:05.000Z";
    });
    webTestCheck(report, "formData expands arrays of objects", () => {
        let fd = objectToFormData({ items: [{ id: 1 }, { id: 2 }] });
        let ids = fd.getAll("items[id]");
        return ids.length === 2 && ids[0] === "1" && ids[1] === "2";
    });
    webTestCheck(report, "objectToFormData(undefined) returns undefined", () => {
        return objectToFormData(undefined) === undefined;
    });
}

/** Verify JSON parsing is automatic on success yet never throws on bad input. */
function webTestJson(report: WebTestReport): void {
    webTestCheck(report, "tryParseJson reads valid json", () => {
        let [ok, value] = tryParseJson('{"a":1}');
        return ok === true && value.a === 1;
    });
    webTestCheck(report, "tryParseJson reports invalid json without throwing", () => {
        let [ok, value] = tryParseJson("not json {");
        return ok === false && value === undefined;
    });
    webTestCheck(report, "tryParseJson handles missing body", () => {
        let [ok] = tryParseJson(undefined);
        return ok === false;
    });
    webTestCheck(report, "responseJSON parses a successful body", () => {
        let fake = new FakeXhr().programLoad(200, '{"name":"ok","n":3}');
        let r = fakeRequest(fake);
        let parsed: any = null;
        r.send("/json", (req) => { parsed = req.responseJSON; });
        return parsed && parsed.name === "ok" && parsed.n === 3;
    });
    webTestCheck(report, "responseJSON returns undefined for malformed body", () => {
        let fake = new FakeXhr().programLoad(200, "<html>not json</html>");
        let r = fakeRequest(fake);
        let threw = false;
        let value: any = "sentinel";
        r.send("/bad-json", (req) => {
            try { value = req.responseJSON; } catch (e) { threw = true; }
        });
        return !threw && value === undefined;
    });
    webTestCheck(report, "tryJson exposes parse success flag on the request", () => {
        let fake = new FakeXhr().programLoad(200, "still not json");
        let r = fakeRequest(fake);
        let ok: any = null;
        r.send("/bad-json-2", (req) => { ok = req.tryJson()[0]; });
        return ok === false;
    });
}

/** Verify caching honours a time to live and can be explicitly bypassed. */
function webTestCache(report: WebTestReport): void {
    webTestCheck(report, "cache ttl option normalises correctly", () => {
        return webRequestCacheTtl(true) === Infinity
            && webRequestCacheTtl(5000) === 5000
            && webRequestCacheTtl(false) === 0
            && webRequestCacheTtl(0) === 0
            && webRequestCacheTtl(undefined) === 0;
    });
    webTestCheck(report, "LocalCache recalls a fresh entry", () => {
        let c = new LocalCache();
        c.store("/x", "value", 10000);
        return c.exists("/x") && c.recall("/x") === "value";
    });
    webTestCheck(report, "LocalCache expires an entry once its ttl elapses", () => {
        let c = new LocalCache();
        c.store("/short", "value", 2); // 2ms lifetime
        let freshNow = c.exists("/short");
        let start = Date.now(); // busy wait past the ttl so expiry is deterministic
        while (Date.now() - start < 6) { /* spin */ }
        let goneAfter = !c.exists("/short") && c.recall("/short") === undefined;
        return freshNow && goneAfter;
    });
    webTestCheck(report, "LocalCache treats ttl<=0 as do-not-cache", () => {
        let c = new LocalCache();
        c.store("/z", "value", 0);
        return !c.exists("/z") && c.recall("/z") === undefined;
    });
    webTestCheck(report, "LocalCache clear empties everything", () => {
        let c = new LocalCache();
        c.store("/a", "1", 10000);
        c.store("/b", "2", 10000);
        c.clear();
        return !c.exists("/a") && !c.exists("/b");
    });
    webTestCheck(report, "second request with cache ttl is served without a network hit", () => {
        WebRequest.clearCache();
        let fake = new FakeXhr().programLoad(200, "cached-body");
        let r = fakeRequest(fake);
        let first: string = null;
        let second: string = null;
        r.send("/cache-a", (req) => { first = req.responseText; }, null, 60000);
        r.send("/cache-a", (req) => { second = req.responseText; }, null, 60000);
        return fake.sendCount === 1 && first === "cached-body" && second === "cached-body";
    });
    webTestCheck(report, "cache is shared across WebRequest instances", () => {
        WebRequest.clearCache();
        let fakeA = new FakeXhr().programLoad(200, "shared-body");
        let fakeB = new FakeXhr().programLoad(200, "should-not-be-used");
        let a = fakeRequest(fakeA);
        let b = fakeRequest(fakeB);
        let value: string = null;
        a.send("/cache-shared", null, null, 60000);
        b.send("/cache-shared", (req) => { value = req.responseText; }, null, 60000);
        return fakeA.sendCount === 1 && fakeB.sendCount === 0 && value === "shared-body";
    });
    webTestCheck(report, "refresh bypasses a cached entry", () => {
        WebRequest.clearCache();
        let fake = new FakeXhr().programLoad(200, "v1");
        let r = fakeRequest(fake);
        r.send("/cache-refresh", null, null, 60000);          // populates cache, send #1
        r.send("/cache-refresh", { cache: 60000, refresh: true }); // bypasses, send #2
        return fake.sendCount === 2;
    });
    webTestCheck(report, "no cache option means every call hits the network", () => {
        let fake = new FakeXhr().programLoad(200, "body");
        let r = fakeRequest(fake);
        r.send("/no-cache");
        r.send("/no-cache");
        return fake.sendCount === 2;
    });
}

/** Verify failures are classified into distinct, actionable categories. */
function webTestFailures(report: WebTestReport): void {
    webTestCheck(report, "successful request reports ok and no error", () => {
        let fake = new FakeXhr().programLoad(200, "ok");
        let r = fakeRequest(fake);
        r.send("/ok");
        return r.ok === true && r.error.kind === WebRequestErrorKind.None;
    });
    webTestCheck(report, "status error is classified as Status with the code", () => {
        let fake = new FakeXhr().programLoad(500, "boom");
        let r = fakeRequest(fake);
        let kind: WebRequestErrorKind = null;
        let status = -1;
        r.send("/err", null, (req) => { kind = req.error.kind; status = req.error.status; });
        return kind === WebRequestErrorKind.Status && status === 500 && r.ok === false;
    });
    webTestCheck(report, "404 is a Status error", () => {
        let fake = new FakeXhr().programLoad(404, "missing");
        let r = fakeRequest(fake);
        r.send("/missing", null, () => { });
        return r.error.kind === WebRequestErrorKind.Status && r.error.status === 404;
    });
    webTestCheck(report, "transport failure is classified as Network", () => {
        let fake = new FakeXhr().programNetwork();
        let r = fakeRequest(fake);
        let kind: WebRequestErrorKind = null;
        r.send("/down", null, (req) => { kind = req.error.kind; });
        return kind === WebRequestErrorKind.Network;
    });
    webTestCheck(report, "timeout invokes the timeout handler with a Timeout error", () => {
        let fake = new FakeXhr().programTimeout();
        let r = fakeRequest(fake);
        let timedOut: any = null;
        let kind: WebRequestErrorKind = null;
        r.send("/slow", { ontimeout: (req) => { timedOut = true; kind = req.error.kind; }, timeout: 1000 });
        return timedOut === true && kind === WebRequestErrorKind.Timeout;
    });
    webTestCheck(report, "timeout falls back to the error handler when no timeout handler is set", () => {
        let fake = new FakeXhr().programTimeout();
        let r = fakeRequest(fake);
        let kind: WebRequestErrorKind = null;
        r.send("/slow-2", null, (req) => { kind = req.error.kind; });
        return kind === WebRequestErrorKind.Timeout;
    });
    webTestCheck(report, "cancel records an Aborted error", () => {
        let fake = new FakeXhr().programLoad(200, "ok");
        let r = fakeRequest(fake);
        r.cancel();
        return r.error.kind === WebRequestErrorKind.Aborted;
    });
    webTestCheck(report, "error messages differ per category", () => {
        let names: { [k: string]: string } = {};
        names["status"] = webRequestError(WebRequestErrorKind.Status, 500).message;
        names["timeout"] = webRequestError(WebRequestErrorKind.Timeout).message;
        names["network"] = webRequestError(WebRequestErrorKind.Network).message;
        names["aborted"] = webRequestError(WebRequestErrorKind.Aborted).message;
        let unique = [names["status"], names["timeout"], names["network"], names["aborted"]];
        return unique[0].indexOf("500") >= 0
            && new Set(unique).size === 4;
    });
}

/** Verify request configuration (timeout and headers) reaches the transport. */
function webTestConfig(report: WebTestReport): void {
    webTestCheck(report, "timeout option is applied to the transport", () => {
        let fake = new FakeXhr().programLoad(200, "ok");
        let r = fakeRequest(fake);
        r.send("/cfg", { timeout: 2500 });
        return fake.timeout === 2500;
    });
    webTestCheck(report, "headers are forwarded to the transport", () => {
        let fake = new FakeXhr().programLoad(200, "ok");
        let r = fakeRequest(fake);
        r.send("/cfg", { headers: { "X-Test": "1", "Accept": "application/json" } });
        return fake.headers["X-Test"] === "1" && fake.headers["Accept"] === "application/json";
    });
    webTestCheck(report, "post serialises an object body through objectToFormData", () => {
        let fake = new FakeXhr().programLoad(200, "ok");
        let r = fakeRequest(fake);
        r.post("/submit", { name: "bob", roles: ["a", "b"] });
        let body: FormData = fake.lastBody;
        return fake.lastMethod === "POST"
            && body instanceof FormData
            && body.get("name") === "bob"
            && body.getAll("roles").length === 2;
    });
    webTestCheck(report, "legacy positional callback signature still works", () => {
        let fake = new FakeXhr().programLoad(200, "legacy-ok");
        let r = fakeRequest(fake);
        let got: string = null;
        // old style: send(url, onsuccess, onerror, cache)
        r.send("/legacy", (req) => { got = req.responseText; }, null, false);
        return got === "legacy-ok";
    });
}

/** Run every WebRequest assertion against the supplied reporter.
 * @param report Receives the name and outcome of each assertion.
 * @returns True when every assertion passed.
 */
function webRequestSelfTest(report: WebTestReport): boolean {
    let failures = 0;
    let wrapped: WebTestReport = (name, ok) => {
        if (!ok) failures++;
        report(name, ok);
    };
    webTestFormData(wrapped);
    webTestJson(wrapped);
    webTestCache(wrapped);
    webTestFailures(wrapped);
    webTestConfig(wrapped);
    return failures === 0;
}

/** Browser facing entry point that renders results using the Test diagnostics. */
class WebRequestTests {
    /** Run the suite and write each result to the document. */
    static run(): boolean {
        Test.writeBreak("WebRequest");
        return webRequestSelfTest((name, ok) => Test.verify(ok, name));
    }
}

// When loaded directly under Node (for headless verification) run the suite and
// reflect the outcome in the process exit code. In a browser this block is inert
// and callers use WebRequestTests.run() instead.
declare const process: any;
if (typeof process !== "undefined" && process.versions && process.versions.node) {
    let passed = 0;
    let failed = 0;
    let ok = webRequestSelfTest((name, result) => {
        if (result) passed++; else failed++;
        console.log(`${result ? "PASS" : "FAIL"}  ${name}`);
    });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = ok ? 0 : 1;
}
