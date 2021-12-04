/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

import {MAX_SUPPORTED_ARRAY_BUFFER_SIZE} from "./Utils";

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

export class MaxSupportedArrayBufferSizeExceededError extends Error {
    public static readonly MAX_SUPPORTED_ARRAY_BUFFER_SIZE = MAX_SUPPORTED_ARRAY_BUFFER_SIZE;
    constructor(public readonly arrayBuffer: ArrayBuffer) {
        super(`Max supported array buffer size: ${MAX_SUPPORTED_ARRAY_BUFFER_SIZE} exceeded.`);
        this.name = "MaxSupportedArrayBufferSizeExceededError";
    }
}