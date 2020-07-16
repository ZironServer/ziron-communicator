/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

let cache: any[] = [];
export const replacer = (key: string, value: any) =>
    typeof value === "object" && value !== null ?
        cache.includes(value) ? '[Circular]' : cache.push(value) && value : value;
export function safeJsonStringify(value: any): string {
    const res = JSON.stringify(value,replacer);
    cache = [];
    return res;
}

export class JSONString extends String {}
const validJSONStartRegex = /^[ \n\r\t]*[{\[]/;

/**
 * Decodes the JSON data which was transmitted over
 * the wire to a JavaScript value.
 * @param str
 */
export function decodeJson(str: string): any {
    // Performance optimization to detect invalid JSON packet sooner.
    if (!validJSONStartRegex.test(str)) throw Error('Invalid JSON.');
    return JSON.parse(str);
}

/**
 * Encodes a raw JavaScript value into JSON for transferring it over the wire.
 * Supports also objects with circular dependencies.
 * @param value
 */
export function encodeJson(value: any): string {
    if(value instanceof JSONString) return value.toString();
    try {return JSON.stringify(value);}
    catch (_) {return safeJsonStringify(value);}
}