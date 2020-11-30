/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import Transport from "./Transport";
import {StreamCloseCode} from "./StreamCloseCode";
import {StreamState} from "./StreamState";
import {Writable} from "./Utils";

export default class WriteStream {

    public static acceptTimeout: number = 5000;

    public readonly state: StreamState = StreamState.Unused;

    public onOpen: () => void | Promise<any> = () => {};
    public onClose: (code: StreamCloseCode | number) => void | Promise<any> = () => {};
     /**
     * @description
     * Is called whenever one of the listeners
     * (onOpen,onClose) have thrown an error.
     */
    public onListenerError?: (err: Error) => void;

    private _closePromiseResolve: () => void;
    public readonly closed: Promise<void> = new Promise(resolve => this._closePromiseResolve = resolve);

    private _id: number;
    private _transport: Transport;

    private _acceptTimeoutTicker: NodeJS.Timeout;

    constructor(onOpen?: () => void | Promise<any>,onClose?: (code: StreamCloseCode | number) => void | Promise<any>) {
        if(onOpen) this.onOpen = onOpen;
        if(onClose) this.onClose = onClose;
    }

    /**
     * @internal
     * @private
     */
    _init(transport: Transport, id: number) {
        if(this.state !== StreamState.Unused) throw new Error('Write-stream already used.');
        this._transport = transport;
        this._id = id;
        (this as Writable<WriteStream>).state = StreamState.Pending;
        this._transport._addWriteStream(id,this);
        this._acceptTimeoutTicker = setTimeout(() => this.close(StreamCloseCode.AcceptTimeout),
            WriteStream.acceptTimeout);
    }

    /**
     * @internal
     * @private
     */
    _open() {
        clearTimeout(this._acceptTimeoutTicker);
        (this as Writable<WriteStream>).state = StreamState.Open;
        try {this.onOpen()}
        catch(err) {this._onListenerError(err)}
    }

    private _onListenerError(err: Error) {
        if(this.onListenerError) {
            try {this.onListenerError(err)}
            catch(_) {}
        }
    }

    write(data: any, processComplexTypes?: boolean) {
        if(this.state !== StreamState.Open) return;
        this._transport._sendStreamChunk(this._id,data,processComplexTypes);
    }

    writeAndClose(data: any, processComplexTypes?: boolean, code: StreamCloseCode | number = 200) {
        if(this.state !== StreamState.Open) return;
        (this as Writable<WriteStream>).state = StreamState.Closed;
        this._transport._sendWriteStreamClose(this._id,code,data,processComplexTypes);
        clearTimeout(this._acceptTimeoutTicker);
        this._transport._removeWriteStream(this._id);
        try {this.onClose(code)}
        catch(err) {this._onListenerError(err)}
        this._closePromiseResolve();
    }

    /**
     * @internal
     */
    _emitBadConnection() {
        if(this.state === StreamState.Closed) return;
        (this as Writable<WriteStream>).state = StreamState.Closed;
        clearTimeout(this._acceptTimeoutTicker);
        try {this.onClose(StreamCloseCode.BadConnection)}
        catch(err) {this._onListenerError(err)}
        this._closePromiseResolve();
    }

    close(code: StreamCloseCode | number = 200) {
        if(this.state === StreamState.Closed) return;
        const prevState = this.state;
        (this as Writable<WriteStream>).state = StreamState.Closed;
        if(prevState !== StreamState.Unused) {
            clearTimeout(this._acceptTimeoutTicker);
            this._transport._sendWriteStreamClose(this._id,code);
            this._transport._removeWriteStream(this._id);
        }
        try {this.onClose(code)}
        catch(err) {this._onListenerError(err)}
        this._closePromiseResolve();
    }

    /**
     * @internal
     */
    public toJSON() {
        return '[WriteStream]';
    }
}