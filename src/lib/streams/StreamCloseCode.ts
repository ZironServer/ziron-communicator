/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

export const enum StreamCloseCode {
    ChunkTimeout = 400,
    BadConnection = 401,
    InvalidChunk = 402,
    SizeLimitExceeded = 403,
    AcceptTimeout = 404,
    SizePermissionTimeout = 405,
    EndClosureTimeout = 406,
    Abort = 407,
    InvalidAction = 408,
    End = 200
}
