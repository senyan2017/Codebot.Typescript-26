/**
 * Type declarations for the resource loader defined in boot.resource.ts.
 *
 * The ResourceLoader class and its global singleton `resourceLoader`
 * are compiled into boot.js (which loads first).  This .d.ts file
 * gives the app compilation (app.js) the type information it needs
 * without re-emitting the class definition.
 */

declare type ResourceType = "script" | "stylesheet" | "text";

declare interface ResourceEntry {
    readonly url: string;
    readonly type: ResourceType;
    loaded: boolean;
}

declare type ResourceLoadCallback = () => void;
declare type TextLoadCallback = (text: string) => void;

declare class ResourceLoader {
    isLoaded(url: string): boolean;
    markLoaded(url: string, type: ResourceType): void;
    getEntries(): ResourceEntry[];
    loadScript(url: string, onload?: ResourceLoadCallback): void;
    loadStyleSheet(url: string, onload?: ResourceLoadCallback): void;
    loadText(url: string, onload: TextLoadCallback): void;
    processHtmlIncludes(oncomplete: ResourceLoadCallback): void;
}

declare const resourceLoader: ResourceLoader;
