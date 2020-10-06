/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

export type Writable<T> = { -readonly [P in keyof T]: T[P] };