/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import {StreamErrorCloseCode} from "./StreamErrorCloseCode";

export default class StreamCloseError extends Error {
    constructor(public readonly code: StreamErrorCloseCode) {
        super(`The stream was closed with the error code: ${code}.`);
    }
}