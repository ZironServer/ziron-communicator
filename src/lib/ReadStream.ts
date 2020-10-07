/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import {Writable} from "./Utils";
import {StreamCloseCode} from "./StreamCloseCode";
import {StreamState} from "./StreamState";
import Communicator from "./Communicator";

export default class ReadStream {

    public readonly state: StreamState = StreamState.Pending;

    private _chainClosed: boolean;
    private _chain: Promise<any>;

    private readonly _createdConnectionLostStamp: number;

    private _receiveTimeoutActive: boolean;
    private _receiveTimeout: number;
    private _receiveTimeoutTick: NodeJS.Timeout;

    /**
     * @description
     * The listener that will be called after each chunk that is received.
     */
    public onChunk: (chunk: any) => void | Promise<any> = () => {};
    /**
     * @description
     * The listener will be called when the stream has closed.
     */
    public onClose: (code: StreamCloseCode | number) => void | Promise<any> = () => {};
     /**
     * @description
     * Is called whenever one of the listeners
     * (onChunk, onClose) have thrown an error.
     */
    public onListenerError?: (err: Error) => void;

    private _closedPromiseResolve: () => void;
    public readonly closed: Promise<void> = new Promise(resolve => this._closedPromiseResolve = resolve);

    public readonly closedCode?: StreamCloseCode | number;

    constructor(private readonly id: number, private readonly communicator: Communicator) {
        this._createdConnectionLostStamp = communicator.connectionLostStamp;
    }

    accept(receiveTimeout: number | null = 5000) {
        if(this.state !== StreamState.Pending) return;

        if(this._createdConnectionLostStamp !== this.communicator.connectionLostStamp) {
            //The connection was lost in-between time.
            return this._connectionLost();
        }

        //init
        this._chain = Promise.resolve();
        this._chainClosed = false;

        this.communicator._addReadStream(this.id,this);
        (this as Writable<ReadStream>).state = StreamState.Open;
        this.communicator._sendStreamAccept(this.id);
        if(receiveTimeout != null) this.setReceiveTimeout(receiveTimeout);
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * @description
     * Will close the stream.
     * Also notifies the WriteStream.
     */
    close(code: StreamCloseCode | number = StreamCloseCode.Abort) {
        this.communicator._sendReadStreamClose(this.id,code);
        this._close(code);
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * Sets a timeout that will close the stream with failure when no end or
     * chunk package is received in the given time.
     * @param timeout
     */
    private setReceiveTimeout(timeout: number = 5000) {
        this._receiveTimeout = timeout;
        this._receiveTimeoutTick =
            setTimeout(() => this._close(StreamCloseCode.ReceiveTimeout), timeout);
        this._receiveTimeoutActive = true;
    }

    /**
     * @private
     */
    private _resetReceiveTimeout() {
        clearTimeout(this._receiveTimeoutTick);
        this._receiveTimeoutTick =
            setTimeout(() => this._close(StreamCloseCode.ReceiveTimeout),this._receiveTimeout);
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
    _addChunkToChain(chunkPromise: Promise<any | ArrayBuffer>) {
        if(this.state === StreamState.Open && !this._chainClosed) {
            if(this._receiveTimeoutActive) this._resetReceiveTimeout();
            this._chain = this._chain.then(() => this._handleChunkPromise(chunkPromise));
        }
    }

    private async _handleChunkPromise(chunkPromise: Promise<any | ArrayBuffer>) {
        try {this._newChunk(await chunkPromise);}
        catch (e) {this._close(StreamCloseCode.ChunkResolveFailure);}
    }

    private _newChunk(chunk: any | ArrayBuffer) {
        if(this.state === StreamState.Open) {
            try {this.onChunk(chunk);}
            catch(err) {this._onListenerError(err);}
        }
    }

    /**
     * @internal
     */
    _addCloseToChain(code: StreamCloseCode | number)  {
        if(this.state === StreamState.Open && !this._chainClosed) {
            this._chainClosed = true;
            if(this._receiveTimeoutActive) clearTimeout(this._receiveTimeoutTick);
            this._chain = this._chain.then(() => this._close(code));
        }
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * @internal
     */
    _connectionLost() {
        this._close(StreamCloseCode.ConnectionLost,false);
    }

    /**
     * @internal
     */
    _close(code: StreamCloseCode | number, rmFromCommunicator: boolean = true) {
        if(this.state === StreamState.Closed) return;
        (this as Writable<ReadStream>).state = StreamState.Closed;
        (this as Writable<ReadStream>).closedCode = code;
        this._chainClosed = true;
        if(this._receiveTimeoutActive) clearTimeout(this._receiveTimeoutTick);
        if(rmFromCommunicator) this.communicator._removeReadStream(this.id);
        try {this.onClose(code);}
        catch(err) {this._onListenerError(err)}
        this._closedPromiseResolve();
    }

    /**
     * @internal
     */
    public toJSON() {
        return '[ReadStream]';
    }
}