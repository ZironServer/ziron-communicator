/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

export type Writeable<T> = { -readonly [P in keyof T]: T[P] };