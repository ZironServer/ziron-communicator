/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import {Writable} from "../Utils";
import {StreamErrorCloseCode} from "./StreamErrorCloseCode";
import {StreamState} from "./StreamState";
import Transport from "../Transport";
import {DataType} from "../DataType";
import LinkedBuffer from "./LinkedBuffer";
import StreamCloseError from "./StreamCloseError";

interface ReadStreamOptions {
    /**
     * @description
     * The size of the buffer to buffer incoming chunks.
     * Minimum value is 1.
     * @default object mode: 8 or binary: 16384 (16KB)
     */
    bufferSize?: number;
    /**
     * @description
     * Whenever the stream is open, the buffer is empty, the WriteStream has permission,
     * and the ReadStream doesn't receive any new chunks in the given timeout,
     * the stream will be closed in an error state.
     * It helps to detect and close dead streams.
     * You can disable this timeout with null when you can trust the other side.
     * @default 5000
     */
    chunkTimeout?: number | null;
    /**
     * @description
     * Sets a size limit for the stream.
     * If the limit is exceeded, the stream will be closed with an error.
     * In binary mode, the limit is specified in bytes and in object mode in the count of objects.
     * When setting this option to null unlimited data
     * can be transmitted through the stream.
     * @default null
     */
    sizeLimit?: number | null;
}

export default class ReadStream {

    /**
     * @description
     * The current state of the stream.
     */
    public readonly state: StreamState = StreamState.Pending;

    /**
     * @description
     * Indicates if the ReadStream is accepted.
     */
    public readonly accepted: boolean;

    private readPromise: Promise<any> | null;
    private readResolve: ((chunk: any) => void) | null;

    private _sizeLimit?: number | null;

    private _buffer: LinkedBuffer
    private _bufferSizeLimit: number;

    private _allowedSize: number;
    private _receivedSize: number;

    private _chunkChainEnd: boolean;
    private _chunkChainCancel: boolean;
    private _chunkChain: Promise<any>;
    private _chunkChainSize: number;

    private readonly _createdBadConnectionTimestamp: number;

    /*
    Timeout to close unused streams.
    The timeout needs to run when the buffer has no data,
    and no chunk is in the chain and when the chain is open.
    The timeout can be cleared when the buffer is not empty,
    or chunks are in the chain or the chain is closed.
     */
    private _chunkTimeoutActive: boolean;
    private _chunkTimeout: number;
    private _chunkTimeoutTick: NodeJS.Timeout;

    private _allowMoreMinTimeout: NodeJS.Timeout;

    /**
     * @description
     * The chunk middleware can be used to validate incoming stream chunks.
     * When false is returned, the stream will be closed immediately.
     * The middleware also allows changing incoming chunks.
     * It doesn't matter if you increase the size of the chunk in the middleware.
     * Only the size when the chunk was received is used.
     */
    public chunkMiddleware?: (chunk: any, updateChunk: (chunk: any) => void, type: DataType) => boolean | Promise<boolean>;

    /**
     * @description
     * A listener that gets called when the stream is closed.
     * An error code is provided when the stream is closed because of an error.
     */
    public onClose: (errorCode?: StreamErrorCloseCode | number) => void | Promise<any> = () => {};
     /**
     * @description
     * Is called whenever one of the listener
     * (onClose) have thrown an error.
     */
    public onListenerError?: (err: Error) => void;

    private _closedPromiseResolve: (errorCode?: StreamErrorCloseCode | number) => void;

    /**
     * @description
     * A promise that gets resolved with the error code when the stream closes.
     */
    public readonly closed: Promise<StreamErrorCloseCode | number | undefined> = new Promise(resolve => this._closedPromiseResolve = resolve);

    /**
     * @description
     * When the stream is closed with an error,
     * this property can be used to access the error code.
     */
    public readonly errorCode?: StreamErrorCloseCode | number;

    constructor(private readonly id: number, private readonly _transport: Transport) {
        this._createdBadConnectionTimestamp = _transport.badConnectionTimestamp;
    }

    /**
     * @description
     * Indicates if this is a binary stream.
     */
    get binary(): boolean {
        //negative id indicates binary stream
        return this.id < 0;
    }

    /**
     * @description
     * Returns if the ReadStream has been closed without an error code.
     */
    get successfullyClosed(): boolean {
        return this.state === StreamState.Closed && this.errorCode == null;
    }

    /**
     * Accepts the stream.
     * @param options
     */
    accept({sizeLimit,bufferSize,chunkTimeout = 5000}: ReadStreamOptions = {}) {
        if(this.state !== StreamState.Pending)
            throw new Error("Cannot accept a not pending ReadStream.");

        if(this._createdBadConnectionTimestamp !== this._transport.badConnectionTimestamp) {
            //The connection was lost in-between time.
            //When the stream is not registered in the transporter,
            // it is needed because then the stream will not be notified of a connection lost.
            return this._emitBadConnection();
        }

        //init
        this._sizeLimit = sizeLimit;
        this._bufferSizeLimit = bufferSize ?
            Math.max(1,bufferSize) : (this.binary ? 16384 : 8);
        this._buffer = new LinkedBuffer();

        this._allowedSize = this._bufferSizeLimit;
        this._receivedSize = 0;

        this._chunkChain = Promise.resolve();
        this._chunkChainEnd = false;
        this._chunkChainCancel = false;
        this._chunkChainSize = 0;

        this._transport._addReadStream(this.id,this);
        (this as Writable<ReadStream>).state = StreamState.Open;
        (this as Writable<ReadStream>).accepted = true;
        this._transport._sendStreamAccept(this.id,this._bufferSizeLimit);

        if(chunkTimeout != null) {
            this._chunkTimeout = chunkTimeout;
            this._chunkTimeoutActive = true;
            this._setChunkTimeout();
        }

    }

    /**
     * @description
     * Use this method to close the Read- and Write-Stream with an error code immediately.
     * The method is helpful to deny a stream or abort a stream.
     * It can only be used when the ReadStream is not already closed.
     * When a read chunk is invalid, you should not use this method to close the stream in an error state.
     * Instead, you should use the chunk middleware.
     * Because when the ReadStream has processed the last chunks successfully and
     * pushed them in the buffer, it closes without an error.
     * You can still read the chunks, but when you determine that a chunk is incompatible,
     * it is not possible to close the ReadStream with an error because it is already closed successfully.
     * @param errorCode
     */
    close(errorCode: StreamErrorCloseCode | number) {
        if(this.state === StreamState.Closed) return;
        if(this._createdBadConnectionTimestamp !== this._transport.badConnectionTimestamp) {
            //The connection was lost in-between time.
            //When the stream is not registered in the transporter,
            // it is needed because then the stream will not be notified of a connection lost.
            return this._emitBadConnection();
        }
        this._transport._sendReadStreamClose(this.id,errorCode);
        this._close(errorCode);
    }

    private _checkAllowMore(applyMinimum?: boolean) {
        if(this._chunkChainEnd || this.state !== StreamState.Open) return;
        /*
         Calculate the potential buffer size by adding the
         currently used buffer size and the size that can still be added.
         Subtract the potential buffer size from the limit to get the safe available free space.
         If the free space is greater than 20% of the buffer limit, allow the client to send more.

         Example:

         bufferLimit: 16
         currentBufferSize: 5

         Allowed: 40
         Received: 38

         potential buffer size: 5 + (40 - 38) = 7
         free space: 16 - 7 = 9

         free space >= (0.2 * 16 = 3.2): yes
         */
        const freeBufferSize = this._bufferSizeLimit - (this._buffer.size + (this._allowedSize - this._receivedSize));
        if(freeBufferSize >= (applyMinimum ? 1 : (0.2 * this._bufferSizeLimit))) {
            this._allowedSize += freeBufferSize;
            this._transport._sendStreamAllowMore(this.id,freeBufferSize);
            clearTimeout(this._allowMoreMinTimeout);
        }
        else this._allowMoreMinTimeout = setTimeout(() => this._checkAllowMore(true),3000);
    }

    async *[Symbol.asyncIterator] () {
        const chunk = await this.read();
        if(chunk !== null) yield chunk;
    }

    /**
     * @description
     * Reads a chunk from the stream.
     * The chunk is eventually returned from the buffer.
     * Otherwise, it waits for a new chunk from the WriteStream.
     * It returns null when the stream is closed and no more chunks are available.
     * Notice it can happen that the stream is already closed,
     * but the read method can still return chunks from the buffer.
     * So use the return value as an indicator and not the stream state.
     */
    read(): Promise<ArrayBuffer | string | any | null> {
        if(!this.accepted) {
            if(this.state === StreamState.Pending) throw new Error("Accept ReadStream before start reading.");
            else {
                // ReadStream is closed before accepted
                return Promise.resolve(null);
            }
        }

        if(this.readPromise) return this.readPromise;
        else if(this._buffer.length > 0) {
            const chunk = this._buffer.shift();
            this._emptyChunksCheck();
            this._checkAllowMore();
            return Promise.resolve(chunk);
        }
        else if(!this._chunkChainEnd) return this.readPromise = new Promise(r => this.readResolve = r);
        else return Promise.resolve(null);
    }

    /**
     * @description
     * Reads all chunks until no more chunks are available and the stream is closed.
     * Only use this method when the whole context is needed because
     * the complete data is buffered in the memory.
     * It is highly recommended to specify a sizeLimit in the accept method when using this method.
     * Internally it uses the read method,
     * so only use this method or either the read method.
     * The method throws an StreamCloseError when the stream is closed with an error.
     * @throws StreamCloseError
     */
    async readAll(): Promise<ArrayBuffer[] | any[]> {
        const buffer: ArrayBuffer[] | any[] = [];
        let chunk = await this.read();
        while (chunk != null) {
            buffer.push(chunk);
            chunk = await this.read();
        }
        if(this.errorCode == null) return buffer;
        else throw new StreamCloseError(this.errorCode);
    }

    private _setChunkTimeout() {
        if(!this._chunkTimeoutActive) return;
        this._clearChunkTimeout(); //for safety to not overwrite an already existing timeout
        this._chunkTimeoutTick =
            setTimeout(() => this.close(StreamErrorCloseCode.ChunkTimeout), this._chunkTimeout);
    }

    private _emptyChunksCheck() {
        if(!this._chunkChainEnd && this._buffer.length <= 0 && this._chunkChainSize <= 0)
            this._setChunkTimeout();
    }

    /**
     * @private
     */
    private _clearChunkTimeout() {
        clearTimeout(this._chunkTimeoutTick);
    }


    private _onListenerError(err: Error) {
        if(this.onListenerError) {
            try {this.onListenerError(err)}
            catch(_) {}
        }
    }

    /**
     * @internal
     */
    _pushChunk(chunk: Promise<any> | ArrayBuffer | null, type: DataType) {
        if(this.state === StreamState.Open && !this._chunkChainEnd) {
            this._chunkChainSize++;
            this._clearChunkTimeout();
            this._chunkChain = this._chunkChain.then(() => this._chunkChainNext(chunk, type));
        }
    }

    private async _chunkChainNext(chunk: Promise<any> | ArrayBuffer | null, type: DataType) {
        if(this._chunkChainCancel) return;
        await this._processChunk(chunk,type);
        this._chunkChainSize--;
        this._emptyChunksCheck();
    }

    private async _processChunk(chunk: Promise<any> | ArrayBuffer | null, type: DataType) {
        try {
            chunk = await chunk;

            if(chunk === null) {
                //EOF
                this._transport._sendReadStreamClose(this.id);
                this._close(undefined,true);
                return;
            }

            if(this._chunkChainCancel) return;

            if(this.binary && type !== DataType.Binary) {
                this.close(StreamErrorCloseCode.InvalidChunk);
                return this._transport.onInvalidMessage(new Error('Invalid stream chunk.'));
            }

            const size = this.binary ? (chunk as ArrayBuffer).byteLength : 1;
            if(
                (this._sizeLimit != null && (this._receivedSize + size) > this._sizeLimit) ||
                (size + this._receivedSize > this._allowedSize)
            ) return this.close(StreamErrorCloseCode.SizeLimitExceeded);

            if(this.chunkMiddleware && !await this.chunkMiddleware(chunk,c => chunk = c,type)) {
                this.close(StreamErrorCloseCode.InvalidChunk);
                return this._transport.onInvalidMessage(new Error('Invalid stream chunk.'));
            }

            if(this._chunkChainCancel) return;
            this._receivedSize += size;
            if(this.readResolve) {
                const resolve = this.readResolve;
                this.readResolve = null;
                this.readPromise = null;
                this._checkAllowMore();
                resolve(chunk);
            }
            else {
                this._buffer.push(chunk,size);
                this._clearChunkTimeout();
            }
        }
        catch (e) {
            this.close(StreamErrorCloseCode.InvalidChunk);
            this._transport.onInvalidMessage(e);
        }
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * @internal
     */
    _emitBadConnection() {
        this._close(StreamErrorCloseCode.BadConnection,false);
    }

    _cancelChunkChain() {
        this._chunkChainCancel = true;
        this._chunkChainEnd = true;
        this._chunkChainSize = 0;
    }

    /**
     * @internal
     */
    _close(errorCode?: StreamErrorCloseCode | number, rmFromTransport: boolean = true) {
        if(this.state === StreamState.Closed) return;
        (this as Writable<ReadStream>).state = StreamState.Closed;
        (this as Writable<ReadStream>).errorCode = errorCode;
        this._cancelChunkChain();
        this._clearChunkTimeout();
        if(this.readResolve) {
            const resolve = this.readResolve;
            this.readResolve = null;
            this.readPromise = null;
            resolve(null);
        }
        if(rmFromTransport) this._transport._removeReadStream(this.id);
        try {this.onClose(errorCode);}
        catch(err) {this._onListenerError(err)}
        this._closedPromiseResolve(errorCode);
    }

    /**
     * @internal
     */
    public toJSON() {
        return '[ReadStream]';
    }
}