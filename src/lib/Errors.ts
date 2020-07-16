/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
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

export class ConnectionLostError extends Error {
    constructor(message: string = 'The connection is lost.') {
        super(message);
        this.name = 'ConnectionLostError';
    }
}