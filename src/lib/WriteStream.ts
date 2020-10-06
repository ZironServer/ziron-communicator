/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import Communicator from "./Communicator";
import {PacketType} from "./Protocol";
import {StreamCloseCode} from "./StreamCloseCode";
import {StreamState} from "./StreamState";
import {Writeable} from "./Utils";

export default class WriteStream {

    public static acceptTimeout: number = 5000;

    public readonly state: StreamState = StreamState.Unused;

    public onOpen: () => void | Promise<any> = () => {};
    public onClose: (code: StreamCloseCode | number) => void | Promise<any> = () => {};

    private _closePromiseResolve: () => void;
    public readonly closed: Promise<void> = new Promise(resolve => this._closePromiseResolve = resolve);

    private _id: number;
    private _communicator: Communicator;

    private _acceptTimeoutTicker: NodeJS.Timeout;

    /**
     * @internal
     * @private
     */
    _init(communicator: Communicator, id: number) {
        if(this.state !== StreamState.Unused) throw new Error('Write-stream already used.');
        this._communicator = communicator;
        this._id = id;
        (this as Writeable<WriteStream>).state = StreamState.Pending;
        this._communicator._addWriteStream(id,this);
        this._acceptTimeoutTicker = setTimeout(() => this.close(StreamCloseCode.AcceptTimeout),
            WriteStream.acceptTimeout);
    }

    /**
     * @internal
     * @private
     */
    _open() {
        clearTimeout(this._acceptTimeoutTicker);
        (this as Writeable<WriteStream>).state = StreamState.Open;
        this.onOpen();
    }

    write(data: any, processComplexTypes?: boolean) {
        if(this.state !== StreamState.Open) return;
        this._communicator._sendStreamChunk(this._id,data,processComplexTypes);
    }

    writeAndClose(data: any, processComplexTypes?: boolean, code: StreamCloseCode | number = 200) {
        if(this.state !== StreamState.Open) return;
        (this as Writeable<WriteStream>).state = StreamState.Closed;
        this._communicator._sendWriteStreamClose(this._id,code,data,processComplexTypes);
        clearTimeout(this._acceptTimeoutTicker);
        this._communicator._removeWriteStream(this._id);
        this.onClose(code);
        this._closePromiseResolve();
    }

    /**
     * @internal
     */
    _connectionLost() {
        if(this.state === StreamState.Closed) return;
        (this as Writeable<WriteStream>).state = StreamState.Closed;
        clearTimeout(this._acceptTimeoutTicker);
        this.onClose(StreamCloseCode.ConnectionLost);
        this._closePromiseResolve();
    }

    close(code: StreamCloseCode | number = 200) {
        if(this.state === StreamState.Closed) return;
        const prevState = this.state;
        (this as Writeable<WriteStream>).state = StreamState.Closed;
        if(prevState !== StreamState.Unused) {
            clearTimeout(this._acceptTimeoutTicker);
            this._communicator._sendWriteStreamClose(this._id,code);
            this._communicator._removeWriteStream(this._id);
        }
        this.onClose(code);
        this._closePromiseResolve();
    }

    /**
     * @internal
     */
    public toJSON() {
        return '[WriteStream]';
    }
}