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