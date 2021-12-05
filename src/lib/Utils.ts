/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

export type Writable<T> = { -readonly [P in keyof T]: T[P] };
export const RESOLVED_PROMISE = Object.freeze(Promise.resolve()) as Promise<void>;

export const MAX_UINT_32 = 4294967295;
export const MAX_SUPPORTED_ARRAY_BUFFER_SIZE = MAX_UINT_32 - 1;

export type SendFunction= (msg: ArrayBuffer | string, binary?: boolean, batch?: boolean) => void;

/**
 * @description
 * Sets the not specified options by loading them from the default options.
 * Notice that no copy will be made, and the returned value is the options object.
 * @param options
 * @param defaults
 */
export function loadDefaults<T>(options: Partial<T>,defaults: T): T {
    for (const key in defaults) {
        if(!options.hasOwnProperty(key)) options[key] = defaults[key];
    }
    return options as T;
}

/**
 * Guesses the string max byte size in UTF-8.
 * @param str
 */
export function guessStringSize(str: string) {
    return str.length * 4;
}

/**
 * @description
 * Escape a string for building JSON content.
 * It can be used to escape quotes from receiver/procedure names.
 * @param str
 */
export function escapeJSONString(str: string): string {
    return str.replace(/[\\"']/g, '\\$&')
        .replace(/\u0000/g, '\\0');
}

/**
 * @description
 * Escapes reserved placeholder char sequence for streams and binary content.
 * @param key
 */
export function escapePlaceholderSequence(key: string): string {
    if(key.indexOf("_") === -1) return key;
    return key.replace('_b','__b')
            .replace("_s","__s");
}

/**
 * @description
 * Unescapes reserved placeholder char sequence for streams and binary content.
 * @param key
 */
export function unescapePlaceholderSequence(key: string): string {
    if(key.indexOf("_") === -1) return key;
    return key.replace('__b','_b')
        .replace("__s","_s");
}