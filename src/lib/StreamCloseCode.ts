/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

export const enum StreamCloseCode {
    Success = 200,
    // => 400 Abort codes
    ReceiveTimeout = 400,
    ConnectionLost = 401,
    InvalidChunk = 402,
    AcceptTimeout = 403,
    Abort = 404
}