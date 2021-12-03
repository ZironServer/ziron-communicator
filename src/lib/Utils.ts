/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

export type Writable<T> = { -readonly [P in keyof T]: T[P] };
export const RESOLVED_PROMISE = Object.freeze(Promise.resolve()) as Promise<void>;

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