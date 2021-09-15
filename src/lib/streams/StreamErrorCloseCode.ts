/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

export const enum StreamErrorCloseCode {
    ChunkTimeout = 400,
    BadConnection = 401,
    InvalidChunk = 402,
    SizeLimitExceeded = 403,
    AcceptTimeout = 404,
    SizePermissionTimeout = 405,
    EndClosureTimeout = 406,
    Abort = 407,
}
