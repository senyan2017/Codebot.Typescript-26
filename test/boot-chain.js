#!/usr/bin/env node
/**
 * Structural regression tests for source/boot/boot.ts
 *
 * Validates the startup chain without needing a browser:
 *   1. Include loop uses `continue` (not `break`) on bad nodes
 *   2. All resource loaders have onerror handlers
 *   3. Third-party module dedup checks identifier (not url)
 *   4. Default app path is relative (not absolute legacy path)
 *   5. HTML includes are deduped via sources[]
 *   6. XHR open() handles both HTTP errors and network errors
 *   7. App script in constructor has onerror and empty-src guard
 *   8. Public API (boot.use, boot.require, boot.open) is preserved
 *
 * Run:  node test/boot-chain.js
 */

const fs = require("fs");
const path = require("path");

const BOOT_PATH = path.resolve(__dirname, "../source/boot/boot.ts");
const src = fs.readFileSync(BOOT_PATH, "utf-8");

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
    if (condition) {
        passed++;
        console.log("  PASS  " + label);
    } else {
        failed++;
        console.log("  FAIL  " + label + (detail ? "  —  " + detail : ""));
    }
}

// ---------------------------------------------------------------------------
// 1. Include loop must not `break` on null/empty src
// ---------------------------------------------------------------------------
(function testIncludeBreakGone() {
    // Find the processIncludes block and ensure there's no `break` after a
    // null-src check. The old pattern was:  if (src == null) break;
    const includeBlock = src.match(/processIncludes[\s\S]*?^\s{4}\}/m);
    const hasBreakOnNull = /src\s*==\s*null[\s\S]{0,30}break/.test(includeBlock?.[0] || "");
    check(
        "include loop: no break on null src",
        !hasBreakOnNull,
        "Found `break` near null-src guard — one bad <include> will stop all subsequent includes"
    );
})();

// ---------------------------------------------------------------------------
// 2. Include loop uses `continue` after null/empty src guard
// ---------------------------------------------------------------------------
(function testIncludeContinue() {
    const hasContinueOnNull = /src\s*==\s*null[\s\S]{0,200}continue/.test(src);
    check(
        "include loop: continue on null/empty src",
        hasContinueOnNull,
        "Expected `continue` after null-src guard so remaining includes still process"
    );
})();

// ---------------------------------------------------------------------------
// 3. CSS link has onerror handler
// ---------------------------------------------------------------------------
(function testCssOnError() {
    const cssBlock = src.match(/link\.rel\s*=\s*"stylesheet"[\s\S]{0,300}/);
    const hasOnError = /link\.onerror/.test(cssBlock?.[0] || "");
    check(
        "CSS include: has onerror handler",
        hasOnError,
        "Missing onerror on <link> — failed CSS will hang boot forever"
    );
})();

// ---------------------------------------------------------------------------
// 4. JS script in processIncludes has onerror handler
// ---------------------------------------------------------------------------
(function testJsOnError() {
    const includeBlock = src.match(/private processIncludes[\s\S]*?private processUses/);
    // Count onerror occurrences in processIncludes (should be >=2: css + js)
    const onerrorCount = ((includeBlock?.[0] || "").match(/onerror/g) || []).length;
    check(
        "JS include: has onerror handler in processIncludes",
        onerrorCount >= 2,
        "Expected >=2 onerror handlers in processIncludes (css + js), found " + onerrorCount
    );
})();

// ---------------------------------------------------------------------------
// 5. Module dedup checks window[module.identifier], NOT window[module.url]
// ---------------------------------------------------------------------------
(function testModuleDedup() {
    const usesBlock = src.match(/private processUses[\s\S]*?private processsRequires/);
    const block = usesBlock?.[0] || src;
    const checksIdentifier = /window\[module\.identifier\]/.test(block);
    const checksUrl = /window\[module\.url\]/.test(block);
    check(
        "module dedup: checks window[module.identifier]",
        checksIdentifier,
        "Should use module.identifier (global var name) to detect already-loaded modules"
    );
    check(
        "module dedup: does NOT check window[module.url]",
        !checksUrl,
        "window[module.url] is always undefined — URL is not a window property"
    );
})();

// ---------------------------------------------------------------------------
// 6. processUses script has onerror
// ---------------------------------------------------------------------------
(function testModuleOnError() {
    const usesBlock = src.match(/private processUses[\s\S]*?private processsRequires/);
    const block = usesBlock?.[0] || "";
    const hasOnError = /onerror/.test(block);
    check(
        "module loader: has onerror handler",
        hasOnError,
        "Missing onerror in processUses — failed module will hang boot"
    );
})();

// ---------------------------------------------------------------------------
// 7. processsRequires script has onerror
// ---------------------------------------------------------------------------
(function testRequireOnError() {
    const reqBlock = src.match(/private processsRequires[\s\S]*?private app/);
    const hasOnError = /onerror/.test(reqBlock?.[0] || "");
    check(
        "require loader: has onerror handler",
        hasOnError,
        "Missing onerror in processsRequires — failed require will hang boot"
    );
})();

// ---------------------------------------------------------------------------
// 8. processsRequires does NOT use window[src] for dedup
// ---------------------------------------------------------------------------
(function testRequireNoWindowSrc() {
    const reqBlock = src.match(/private processsRequires[\s\S]*?private app/);
    const hasWindowSrc = /window\[src\]/.test(reqBlock?.[0] || "");
    check(
        "require dedup: does NOT use window[src]",
        !hasWindowSrc,
        "window[src] checks a URL as a window key — always undefined, dead code"
    );
})();

// ---------------------------------------------------------------------------
// 9. Default app path is relative, not /typescript/build/app.js
// ---------------------------------------------------------------------------
(function testDefaultPath() {
    const hasLegacyPath = /\/typescript\/build\/app\.js/.test(src);
    const hasRelativePath = /return\s+"build\/app\.js"/.test(src);
    check(
        "default app path: no legacy /typescript/build/app.js",
        !hasLegacyPath,
        "Legacy absolute path breaks pages served from any other directory"
    );
    check(
        "default app path: uses relative build/app.js",
        hasRelativePath,
        "Expected relative path so example.html and test pages work without server config"
    );
})();

// ---------------------------------------------------------------------------
// 10. HTML includes are deduped via sources[]
// ---------------------------------------------------------------------------
(function testHtmlIncludeDedup() {
    // The else branch in processIncludes (for HTML) should check sources[]
    const includeBlock = src.match(/private processIncludes[\s\S]*?private processUses/);
    // Look for sources.indexOf check near the HTML include else block
    const elseBlock = (includeBlock?.[0] || "").match(/else\s*\{[\s\S]*?me\.open/);
    const hasDedup = /sources\.indexOf/.test(elseBlock?.[0] || "");
    check(
        "HTML includes: deduped via sources[]",
        hasDedup,
        "Without dedup, the same HTML partial gets fetched and inserted multiple times"
    );
})();

// ---------------------------------------------------------------------------
// 11. open() handles HTTP errors (non-2xx status) and network errors
// ---------------------------------------------------------------------------
(function testOpenErrorHandling() {
    const openBlock = src.match(/open\(url:\s*string[\s\S]*?request\.send/);
    const openSrc = openBlock?.[0] || "";
    const handlesHttpError = /request\.status/.test(openSrc);
    const handlesNetworkError = /request\.onerror/.test(openSrc);
    check(
        "open(): handles HTTP error status codes",
        handlesHttpError,
        "Without status check, a 404/500 response body gets injected as HTML"
    );
    check(
        "open(): handles network errors (onerror)",
        handlesNetworkError,
        "Missing request.onerror — network failure hangs the include chain"
    );
})();

// ---------------------------------------------------------------------------
// 12. App script in constructor has onerror and empty-src guard
// ---------------------------------------------------------------------------
(function testConstructorAppScript() {
    const ctorBlock = src.match(/constructor\(\)[\s\S]*?^\s{4}\}/m);
    const ctorSrc = ctorBlock?.[0] || "";
    const hasOnError = /onerror/.test(ctorSrc);
    const hasEmptyGuard = /appSrc.*length|!appSrc/.test(ctorSrc);
    check(
        "constructor: app script has onerror",
        hasOnError,
        "Missing onerror for app script — boot hangs if app.js is missing"
    );
    check(
        "constructor: guards against empty app src",
        hasEmptyGuard,
        "Should skip loading when meta[name=boot] content is empty"
    );
})();

// ---------------------------------------------------------------------------
// 13. Public API surface is preserved
// ---------------------------------------------------------------------------
(function testPublicApi() {
    const hasUse = /use\(module:\s*BootModule/.test(src);
    const hasRequire = /require\(script:\s*string\)/.test(src);
    const hasOpen = /open\(url:\s*string/.test(src);
    check("public API: boot.use() preserved", hasUse);
    check("public API: boot.require() preserved", hasRequire);
    check("public API: boot.open() preserved", hasOpen);
})();

// ---------------------------------------------------------------------------
// 14. target-platform filtering still present
// ---------------------------------------------------------------------------
(function testTargetPlatform() {
    const hasTargetCheck = /InvalidTarget/.test(src);
    const hasMobileDesktop = /target\s*==\s*"mobile"/.test(src);
    check(
        "target-platform: InvalidTarget check present",
        hasTargetCheck && hasMobileDesktop,
        "target-platform filtering should still work for mobile/desktop includes"
    );
})();

// ---------------------------------------------------------------------------
// 15. All onerror handlers still advance the chain (call load() or processUses())
// ---------------------------------------------------------------------------
(function testOnErrorCallsLoad() {
    // Every onerror should call load() or processUses() — otherwise the chain stalls
    // Match onerror handlers including nested braces: onerror = () => { ... };
    const onerrorBlocks = src.match(/onerror\s*=\s*\(\)\s*=>\s*\{[^}]*\{?[^}]*\}[^}]*\}/g) || [];
    const allAdvanceChain = onerrorBlocks.every(block => /load\(\)|processUses\(\)|onload\(/.test(block));
    check(
        "onerror handlers: all advance the chain (load/processUses/onload)",
        allAdvanceChain && onerrorBlocks.length >= 4,
        "Found " + onerrorBlocks.length + " onerror blocks, expected >=4, all must advance the chain"
    );
})();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(60));
console.log("  Results: " + passed + " passed, " + failed + " failed, " + (passed + failed) + " total");
console.log("=".repeat(60));

if (failed > 0) {
    console.log("\n  Some boot chain regressions detected — review the failures above.\n");
    process.exit(1);
} else {
    console.log("\n  All boot chain checks passed.\n");
    process.exit(0);
}
