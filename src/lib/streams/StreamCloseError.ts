/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

import {StreamCloseCode} from "./StreamCloseCode";

export default class StreamCloseError extends Error {
    constructor(public readonly code: StreamCloseCode) {
        super(`The stream was closed with the code: ${code}.`);
    }
}