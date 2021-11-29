/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

export enum TimeoutType {
    BinaryResolve,
    InvokeResponse
}

export class TimeoutError extends Error {
    public readonly type: TimeoutType | string;
    constructor(message: string, type: TimeoutType | string) {
        super(message);
        this.name = 'TimeoutError';
        this.type = type;
    }
}

export class InvalidActionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidActionError';
    }
}

export enum BadConnectionType {
    Disconnect,
    ConnectAbort
}

export class BadConnectionError extends Error {
    constructor(type: BadConnectionType,message: string = 'Bad connection') {
        super(message);
        this.name = 'BadConnectionError';
    }
}

export class BackError extends Error {
    public readonly code: number | string;
    constructor(code: number | string,message?: string) {
        super(message);
        this.code = code;
    }
}

export class InsufficientBufferSizeError extends Error {
    constructor(public readonly bufferType: string) {
        super("Insufficient buffer size");
        this.name = "InsufficientBufferSizeError";
    }
}