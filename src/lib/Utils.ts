/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

export type Writable<T> = { -readonly [P in keyof T]: T[P] };
export const RESOLVED_PROMISE = Object.freeze(Promise.resolve()) as Promise<void>;

export const MAX_UINT_32 = 4294967295;
export const MAX_SUPPORTED_ARRAY_BUFFER_SIZE = MAX_UINT_32 - 1;

export type SendFunction= (msg: ArrayBuffer | string, binary?: boolean, compressed?: boolean) => void;

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