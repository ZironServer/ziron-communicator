/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

import {StreamErrorCloseCode} from "./StreamErrorCloseCode";

export default class StreamCloseError extends Error {
    constructor(public readonly code: StreamErrorCloseCode) {
        super(`The stream was closed with the error code: ${code}.`);
    }
}