/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import Transport from "../Transport";
import {StreamErrorCloseCode} from "./StreamErrorCloseCode";
import {StreamState} from "./StreamState";
import {Writable} from "../Utils";

interface TimeoutOption {
    /**
     * @description
     * The ReadStream must accept the WriteStream to continue.
     * The timeout is used to close the stream with an error when the ReadStream never answers.
     * @default 5000
     */
    acceptTimeout?: number,
    /**
     * @description
     * Whenever the WriteStream reaches the allowed size, it waits for permission to write more data.
     * The timeout helps to close the stream in an error state when the
     * ReadStream never sends permission for more data.
     * Be careful and give the ReadStream side some time to read data from the buffer.
     * Only when space is available in the buffer, the ReadStream normally sends permission for more data.
     * When you can trust the other side to send permissions, you can disable this timeout with null.
     * @default 20000
     */
    sizePermissionTimeout?: number | null,
    /**
     * @description
     * When the WriteStream sends the last chunk or the EOF indicator,
     * the ReadStream will close the WriteStream successfully when all chunks
     * have been processed without an error.
     * It does not mean that all chunks on the ReadStream side need to be read;
     * there can still be chunks in the buffer.
     * You can disable this timeout with null when you can trust the
     * other side to close the stream after processing successfully.
     * @default 10000
     */
    endClosureTimeout?: number | null;
}

export default class WriteStream<B extends boolean = false> {

    private readonly acceptTimeout: number = 5000;
    private readonly sizePermissionTimeout: number | null = 20000
    private readonly endClosureTimeout: number | null = 10000;

    /**
     * @description
     * Indicates if this is a binary stream.
     */
    public readonly binary: boolean;
    /**
     * @description
     * The current state of the stream.
     */
    public readonly state: StreamState = StreamState.Unused;

    private _allowedSize: number = 0;
    private _sentSize: number = 0;

    private _resolveSizePermissionWait: ((err?: Error) => void) | null;

    private _writeLock: boolean = false;

    /**
     * @description
     * A listener that gets called when the stream is open.
     */
    public onOpen: () => void | Promise<any> = () => {};
    /**
     * @description
     * A listener that gets called when the stream is closed.
     * An error code is provided when the stream is closed because of an error.
     */
    public onClose: (errorCode?: StreamErrorCloseCode | number) => void | Promise<any> = () => {};
     /**
     * @description
     * Is called whenever one of the listeners
     * (onOpen,onClose) have thrown an error.
     */
    public onListenerError?: (err: Error) => void;

    private _closePromiseResolve: (errorCode: StreamErrorCloseCode | number | undefined) => void;

    /**
     * @description
     * A promise that gets resolved with the error code when the stream closes.
     */
    public readonly closed: Promise<StreamErrorCloseCode | number | undefined> = new Promise(resolve => this._closePromiseResolve = resolve);

    private _openedPromiseResolve: () => void;

    /**
     * @description
     * A promise that gets resolved when the stream opens.
     */
    public readonly opened: Promise<void> = new Promise(resolve => this._openedPromiseResolve = resolve);

    /**
     * @description
     * When the stream is closed with an error,
     * this property can be used to access the error code.
     */
    public readonly errorCode?: StreamErrorCloseCode | number;

    private _id: number;
    private _transport: Transport;

    private _acceptTimeoutTicker: NodeJS.Timeout;
    private _endClosureTimeoutTicker: NodeJS.Timeout;

    constructor(binary?: B,timeouts?: TimeoutOption) {
        this.binary = binary || false;
        this.write = (binary ? this.binaryWrite.bind(this) : this.objectWrite.bind(this)) as any;
        this.writeLast = (binary ? this.binaryWriteLast.bind(this) :
            this.objectWriteLast.bind(this)) as any;
        if(timeouts) Object.assign(this,timeouts);
    }

    /**
     * @description
     * An alternative to manually calling write or write last and checking the return value.
     * The provided callback will be called every time when the previous write was successful
     * and was not an EOF indication.
     * @param loop
     */
    setWriter(loop: (write: (B extends true ? ((data: ArrayBuffer | null) => void) :
        ((data: any | null, processComplexTypes?: boolean) => void))) => void | Promise<void>)
    {
        const write = (...args: any) => {
            (this.write as any)(...args).then((result) => {
                if(result && args[0] != null) loop(write as any);
            })
        };
        loop(write as any);
    }

    private get remainingSizeAllowed(): number {
        return this._allowedSize - this._sentSize;
    }

    /**
     * @internal
     * @private
     * @param transport
     * @param id
     * The id must be negative when the stream is a
     * binary stream or positive when the stream is an object stream.
     */
    _init(transport: Transport, id: number) {
        if((this.binary && id > 0) || (!this.binary && id < 0))
            throw new Error("Id does not match with the stream mode.")
        if(this.state !== StreamState.Unused) throw new Error('Write-stream already used.');
        this._transport = transport;
        this._id = id;
        (this as Writable<WriteStream>).state = StreamState.Pending;
        this._transport._addWriteStream(id,this);
        this._acceptTimeoutTicker = setTimeout(() => this.close(StreamErrorCloseCode.AcceptTimeout),
            this.acceptTimeout);
    }

    /**
     * @internal
     * @private
     */
    _open(bufferSize: number) {
        if(this.state === StreamState.Closed) {
            //Stream is already locally closed (Inform the ReadStream again...)
            //It can happen that this stream was closed in the pending state and the
            //ReadStream could not receive the close package.
            return this._transport._sendWriteStreamClose(this._id,this.errorCode ?? StreamErrorCloseCode.Abort);
        }
        else if(this.state !== StreamState.Pending) {
            //Some strange behaviour close the stream and inform ReadStream...
            return this.close(StreamErrorCloseCode.Abort);
        }

        clearTimeout(this._acceptTimeoutTicker);
        (this as Writable<WriteStream>).state = StreamState.Open;
        try {this.onOpen()}
        catch(err) {this._onListenerError(err)}
        this._openedPromiseResolve();
        this._allowSize(bufferSize);
    }

    /**
     * @internal
     * @private
     * @param size
     */
    _addDataPermission(size: number) {
        this._allowSize(size);
    }

    private waitForMoreSizePermission(): Promise<void> {
        if(this._resolveSizePermissionWait) throw new Error("Already waiting for size permission");
        else return new Promise((res,rej) => {
            let timeoutTicker;
            if(this.sizePermissionTimeout != null) {
                timeoutTicker = setTimeout(() =>
                    this.close(StreamErrorCloseCode.SizePermissionTimeout),this.sizePermissionTimeout)
            }
            this._resolveSizePermissionWait = (err?: Error) => {
                clearTimeout(timeoutTicker);
                this._resolveSizePermissionWait = null;
                err ? rej(err) : res();
            }
        });
    }

    private _allowSize(size: number) {
        if(this.state !== StreamState.Open || size <= 0) return;
        this._allowedSize += size;
        if(this._resolveSizePermissionWait)
            this._resolveSizePermissionWait();
    }

    private _onListenerError(err: Error) {
        if(this.onListenerError) {
            try {this.onListenerError(err)}
            catch(_) {}
        }
    }

    private async binaryWrite(data: ArrayBuffer | null): Promise<boolean> {
        if(this.state === StreamState.Closed) return false;
        if(this._writeLock) throw new Error("The previous write is still being processed.");
        if(this.state !== StreamState.Open) await this.opened;
        if(data === null) {
            this._sendObjectChunk(null);
            this._onEOFSend();
            return true;
        }
        let availableSize = this.remainingSizeAllowed;
        if(data.byteLength <= availableSize) this._sendBinaryChunk(new Uint8Array(data));
        else {
            try {
                this._writeLock = true;
                for(let i = 0; i < data.byteLength;) {
                    if(availableSize <= 0) {
                        await this.waitForMoreSizePermission();
                        availableSize = this.remainingSizeAllowed;
                    }
                    const byteLength = Math.min(data.byteLength - i,availableSize);
                    this._sendBinaryChunk(new Uint8Array(data,i,byteLength))
                    i+= byteLength;
                    availableSize = this.remainingSizeAllowed;
                }
            }
            catch (_) {return false;}
            finally {this._writeLock = false;}
        }
        return true;
    }

    private async objectWrite(data: any | null, processComplexTypes?: boolean): Promise<boolean> {
        if(this.state === StreamState.Closed) return false;
        if(this._writeLock) throw new Error("The previous write is still being processed.");
        if(this.state !== StreamState.Open) await this.opened;

        if(data === null) {
            this._sendObjectChunk(null);
            this._onEOFSend();
            return true;
        }
        if(this.remainingSizeAllowed > 0) this._sendObjectChunk(data,processComplexTypes);
        else {
            try {
                this._writeLock = true;
                await this.waitForMoreSizePermission();
                this._sendObjectChunk(data,processComplexTypes);
            }
            catch (_) {return false;}
            finally {this._writeLock = false;}
        }
        return true;
    }

    /**
     * @description
     * Writes a chunk or EOF indication (with null).
     * Don't call this method when the previous write promise is not resolved yet.
     * The returned promise resolves to true when the write has been transmitted successfully and
     * to false when the write failed because of closure; you then should also stop further writing.
     * In case of an EOF indication, the WriteStream will close with a successful state
     * when the ReadStream has informed the WriteStream that all chunks have been processed successfully.
     */
    readonly write: (B extends true ? ((data: ArrayBuffer | null) => Promise<boolean>) :
        ((data: any | null, processComplexTypes?: boolean) => Promise<boolean>));

    private async binaryWriteLast(data: ArrayBuffer): Promise<boolean> {
        if(this.state === StreamState.Closed) return false;
        if(this._writeLock) throw new Error("The previous write is still being processed.");
        if(this.state !== StreamState.Open) await this.opened;
        if(data.byteLength <= this.remainingSizeAllowed)
            this._sendBinaryChunk(new Uint8Array(data),true);
        else {
            if(!await this.write(data)) return false;
            this._sendObjectChunk(null);
        }
        this._onEOFSend();
        return true;
    }

    private async objectWriteLast(data: any, processComplexTypes?: boolean): Promise<boolean>
    {
        if(this.state === StreamState.Closed) return false;
        if(this._writeLock) throw new Error("The previous write is still being processed.");
        if(this.state !== StreamState.Open) await this.opened;
        if(this.remainingSizeAllowed > 0) this._sendObjectChunk(data,processComplexTypes,true);
        else {
            try {
                this._writeLock = true;
                await this.waitForMoreSizePermission();
                this._sendObjectChunk(data,processComplexTypes,true);
            }
            catch (_) {return false;}
            finally {this._writeLock = false;}
        }
        this._onEOFSend();
        return true;
    }

    /**
     * @description
     * Writes a chunk with EOF indication.
     * Don't call this method when the previous write promise is not resolved yet.
     * The returned promise resolves to true when the write has been transmitted successfully and
     * to false when the write failed because of closure; you then should also stop further writing.
     * The WriteStream will close with a successful state when the ReadStream has
     * informed the WriteStream that all chunks have been processed successfully.
     * In optimal cases, the method packages the chunk and EOF indication in a single package.
     */
    readonly writeLast: (B extends true ? ((data: ArrayBuffer) => Promise<boolean>) :
        ((data: any, processComplexTypes?: boolean) => Promise<boolean>));

    private _sendBinaryChunk(data: Uint8Array,last?: boolean) {
        this._sentSize += data.byteLength;
        this._transport._sendBinaryStreamChunk(this._id,data,last);
    }

    private _sendObjectChunk(data: any, processComplexTypes?: boolean, last?: boolean) {
        this._sentSize += 1;
        this._transport._sendStreamChunk(this._id,data,processComplexTypes,last);
    }

    private _onEOFSend() {
        if(this.endClosureTimeout != null && this._endClosureTimeoutTicker == null) {
            this._endClosureTimeoutTicker = setTimeout(() => {
                this.close(StreamErrorCloseCode.EndClosureTimeout);
            },this.endClosureTimeout);
        }
    }

    /**
     * @internal
     */
    _emitBadConnection() {
        this._close(StreamErrorCloseCode.BadConnection,false)
    }

    /**
     * @internal
     */
    _readStreamClose(errorCode?: StreamErrorCloseCode | number) {
        this._close(errorCode,true);
    }

    /**
     * @description
     * Returns if the WriteStream has been closed without an error code.
     */
    get successfullyClosed(): boolean {
        return this.state === StreamState.Closed && this.errorCode == null;
    }

    /**
     * Use this method to close the Write- and Read-Stream in case of an error immediately.
     * When you have sent all chunks, don't use this method and
     * indicate the EOF with a null or by using the write last method.
     * @param errorCode
     */
    close(errorCode: StreamErrorCloseCode | number) {
        if(this.state === StreamState.Closed) return;
        if(this.state !== StreamState.Unused) this._transport._sendWriteStreamClose(this._id,errorCode);
        this._close(errorCode,true);
    }

    private _close(errorCode?: StreamErrorCloseCode | number, rmFromTransport: boolean = true) {
        if(this.state === StreamState.Closed) return;
        (this as Writable<WriteStream>).state = StreamState.Closed;
        (this as Writable<WriteStream>).errorCode = errorCode;
        clearTimeout(this._acceptTimeoutTicker);
        clearTimeout(this._endClosureTimeoutTicker);
        if(rmFromTransport) this._transport._removeWriteStream(this._id);
        try {this.onClose(errorCode)}
        catch(err) {this._onListenerError(err)}
        if(this._resolveSizePermissionWait)
            this._resolveSizePermissionWait(new Error("Stream is closed."));
        this._closePromiseResolve(errorCode);
    }

    /**
     * @internal
     */
    public toJSON() {
        return '[WriteStream]';
    }
}