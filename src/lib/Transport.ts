/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

import {ActionPacket, BundlePacket, NEXT_BINARIES_PACKET_TOKEN, PacketType,} from "./Protocol";
import {containsStreams, DataType, isMixedJSONDataType, parseJSONDataType} from "./DataType";
import {dehydrateError, hydrateError} from "./ErrorUtils";
import {decodeJson, encodeJson, JSONString} from "./JsonUtils";
import ReadStream from "./streams/ReadStream";
import WriteStream from "./streams/WriteStream";
import {StreamErrorCloseCode} from "./streams/StreamErrorCloseCode";
import {
    escapePlaceholderSequence, guessStringSize, loadDefaults,
    MAX_SUPPORTED_ARRAY_BUFFER_SIZE,
    RESOLVED_PROMISE,
    SendFunction, unescapePlaceholderSequence,
    Writable
} from "./Utils";
import {
    BadConnectionError,
    BadConnectionType,
    InvalidActionError,
    MaxSupportedArrayBufferSizeExceededError,
    TimeoutError,
    TimeoutType
} from "./Errors";
import {InvokePackage, Package} from "./Package";
import PackageBuffer, {PackageBufferOptions} from "./PackageBuffer";

export interface ComplexTypesOption {
    /**
     * Complex types are streams or array buffer.
     * If you want to send such types you need to activate this option.
     * Otherwise, these types will be ignored because of performance reasons.
     */
    processComplexTypes?: boolean
}

export type TransmitListener = (receiver: string, data: any, type: DataType) => void | Promise<void>;
export type InvokeListener = (procedure: string, data: any, end: (data?: any, processComplexTypes?: boolean) => void,
    reject: (err?: any) => void, type: DataType) => void | Promise<void>

type BinaryContentResolver = {
    callback: (err?: Error | null,binaries?: ArrayBuffer[]) => void,
    timeout: NodeJS.Timeout
};

const PING = 57;
const PING_BINARY = new Uint8Array([PING]);

const PONG = 65;
const PONG_BINARY = new Uint8Array([PONG]);

export interface TransportOptions extends PackageBufferOptions {
    ackTimeout: number;
    binaryResolveTimeout: number;
    streamsPerPacketLimit: number;
    streamsEnabled: boolean;
    chunksCanContainStreams: boolean;
    /**
     * The read stream class that is used.
     * Must inherit from the Ziron ReadStream.
     */
    readStream: typeof ReadStream
}

export default class Transport {

    public static readonly DEFAULT_OPTIONS: Readonly<TransportOptions> = {
        readStream: ReadStream,
        ackTimeout: 10000,
        binaryResolveTimeout: 10000,
        streamsPerPacketLimit: 20,
        streamsEnabled: true,
        chunksCanContainStreams: false,
        maxBufferSize: Number.POSITIVE_INFINITY,
        maxBufferChunkLength: 200,
        limitBatchStringLength: 310000,
        limitBatchBinarySize: 3145728,
        stringSizeDeterminer: guessStringSize,
    }

    public static buildOptions(options: Partial<TransportOptions>): TransportOptions {
        return loadDefaults(options,Transport.DEFAULT_OPTIONS);
    }

    public readonly buffer: PackageBuffer;

    public onInvalidMessage: (err: Error) => void;
    /**
     * @description
     * Is called whenever one of the listeners
     * (onTransmit, onInvoke, onPing, onPong) have thrown an error.
     */
    public onListenerError: (err: Error) => void;
    public onTransmit: TransmitListener;
    public onInvoke: InvokeListener;
    public onPing: () => void;
    public onPong: () => void;
    private _send: SendFunction;
    public set send(value: SendFunction) {
        this._send = value;
        this.buffer.send = value;
    }
    public get send(): SendFunction {
        return this._send;
    }
    public hasLowBackpressure: () => boolean;

    public readonly badConnectionTimestamp: number = -1;

    constructor(
        connector: {
            onInvalidMessage?: (err: Error) => void;
            onListenerError?: (err: Error) => void;
            onTransmit?: TransmitListener;
            onInvoke?: InvokeListener;
            onPing?: () => void;
            onPong?: () => void;
            send?: (msg: string | ArrayBuffer) => void;
            /**
             * @description
             * The write streams will pause when the backpressure is
             * not low and are waiting for low pressure.
             * When this method is used, backpressure draining
             * must be emitted with the emitBackpressureDrain method.
             */
            hasLowBackpressure?: () => boolean;
        } = {},
        /**
         * Notice that the provided options will not be cloned to save memory and performance.
         */
        public options: TransportOptions = {...Transport.DEFAULT_OPTIONS},
        connected: boolean = true)
    {
        this.onInvalidMessage = connector.onInvalidMessage || (() => {});
        this.onListenerError = connector.onListenerError || (() => {});
        this.onTransmit = connector.onTransmit || (() => {});
        this.onInvoke = connector.onInvoke || (() => {});
        this.onPing = connector.onPing || (() => {});
        this.onPong = connector.onPong || (() => {});
        this._send = connector.send || (() => {});
        this.hasLowBackpressure = connector.hasLowBackpressure || (() => true);
        this.open = connected;
        this.buffer = new PackageBuffer(this._send,() => this.open,options);
    }

    /**
     * Can not be reset on connection lost
     * because packages with old ids can exist.
     */
    private _binaryContentPacketId: number = 0;
    private _binaryContentResolver: Record<number,BinaryContentResolver> = {};

    /**
     * Can not be reset on connection lost
     * because packages with old ids can exist.
     */
    private _objectStreamId: number = 1;
    private _binaryStreamId: number = -1;
    private _activeReadStreams: Record<string, ReadStream> = {};
    private _activeWriteStreams: Record<string, WriteStream> = {};

    /**
     * Can not be reset on connection lost
     * because packages with old ids can exist.
     */
    private _cid: number = 0;
    private _invokeResponsePromises: Record<number,
        {
            resolve: (data: any) => void,
            reject: (err: any) => void,
            timeout?: NodeJS.Timeout,
            returnDataType?: boolean
        }> = {};

    public readonly open: boolean = true;

    private readonly _lowBackpressureWaiters: (() => void)[] = [];

    /**
     * @internal
     * @private
     */
    _addLowBackpressureWaiter(waiter: () => void) {
        this._lowBackpressureWaiters.push(waiter);
    }

    /**
     * @internal
     * @private
     */
    _cancelLowBackpressureWaiter(waiter: () => void) {
        const index = this._lowBackpressureWaiters.indexOf(waiter);
        if(index !== -1) this._lowBackpressureWaiters.splice(index, 1);
    }

    emitMessage(rawMsg: string | ArrayBuffer) {
        try {
            if(typeof rawMsg !== "string"){
                if(rawMsg.byteLength === 1) {
                    if((new Uint8Array(rawMsg))[0] === PING) {
                        try {this.onPing();}
                        catch (err) {this.onListenerError(err)}
                    }
                    else if((new Uint8Array(rawMsg))[0] === PONG) {
                        try {this.onPong();}
                        catch (err) {this.onListenerError(err)}
                    }
                    else this._processBinaryPacket(rawMsg);
                }
                else this._processBinaryPacket(rawMsg);
            }
            else {
                let packet: BundlePacket | ActionPacket;
                try {packet = decodeJson('[' + rawMsg + ']')}
                catch (err) {return this.onInvalidMessage(err)}
                if(packet) {
                    if(packet['0'] === PacketType.Bundle) {
                        const packets = packet['1'];
                        if(Array.isArray(packets)) {
                            const len = (packets as any[]).length;
                            for(let i = 0; i < len; i++) {
                                this._processJsonActionPacket(packets[i]);
                            }
                        }
                    }
                    else this._processJsonActionPacket(packet);
                }
            }
        }
        catch(e){this.onInvalidMessage(e);}
    }

    emitBackpressureDrain() {
        while(this._lowBackpressureWaiters.length && this.hasLowBackpressure())
            this._lowBackpressureWaiters.shift()!();
    }

    emitBadConnection(type: BadConnectionType,msg?: string) {
        (this as Writable<Transport>).open = false;
        this.buffer.clearBatchTime();
        const err = new BadConnectionError(type,msg);
        (this as Writable<Transport>).badConnectionTimestamp = Date.now();
        this._rejectBinaryContentResolver(err);
        this._rejectInvokeRespPromises(err);
        this._emitBadConnectionToStreams();
        this._activeReadStreams = {};
        this._activeWriteStreams = {};
    }

    emitReconnection() {
        (this as Writable<Transport>).open = true;
        this.buffer.flushBuffer();
    }

    private _onListenerError(err: Error) {
        try {this.onListenerError(err);}
        catch(_) {}
    }

    private _rejectInvokeRespPromises(err: Error) {
        const tmpPromises = this._invokeResponsePromises;
        this._invokeResponsePromises = {};
        for(const k in tmpPromises) {
            if(tmpPromises.hasOwnProperty(k)){
                clearTimeout(tmpPromises[k].timeout!);
                tmpPromises[k].reject(err);
            }
        }
    }

    private _getNewBinaryContentPacketId() {
        if(this._binaryContentPacketId > Number.MAX_SAFE_INTEGER) this._binaryContentPacketId = 0;
        return this._binaryContentPacketId++;
    }

    private _getNewCid(): number {
        if(this._cid > Number.MAX_SAFE_INTEGER) this._cid = 0;
        return this._cid++;
    }

    /**
     * @param binaryStream
     * @private
     */
    private _getNewStreamId(binaryStream: boolean): number {
        if(binaryStream) {
            if(this._binaryStreamId < Number.MIN_SAFE_INTEGER) this._binaryStreamId = -1;
            return this._binaryStreamId--;
        }
        else {
            if(this._objectStreamId > Number.MAX_SAFE_INTEGER) this._objectStreamId = 1;
            return this._objectStreamId++;
        }
    }

    private _processBinaryPacket(buffer: ArrayBuffer) {
        const header = (new Uint8Array(buffer,0,1))[0];
        if(header === PacketType.BinaryContent)
            this._processBinaryContentPacket(new DataView(buffer),1)
        else if(header === PacketType.StreamChunk)
            this._processBinaryStreamChunk((new Float64Array(buffer.slice(1,9)))[0],buffer.slice(9));
        else if(header === PacketType.StreamEnd)
            this._processBinaryStreamEnd((new Float64Array(buffer.slice(1,9)))[0],buffer.slice(9));
        else this.onInvalidMessage(new Error('Unknown binary package header type.'))
    }

    private _processBinaryContentPacket(view: DataView, offset: number) {
        const id = view.getFloat64(offset)
        const resolver = this._binaryContentResolver[id],
            byteLength = view.byteLength,
            binaries: ArrayBuffer[] = [];
        let binaryLen: number;
        offset += 8;

        while(offset < byteLength) {
            binaryLen = view.getUint32(offset);
            offset += 4;
            if(binaryLen === NEXT_BINARIES_PACKET_TOKEN) {
                this._processBinaryContentPacket(view,offset);
                break;
            }
            if(resolver)
                binaries.push(view.buffer.slice(offset,offset + binaryLen));
            offset += binaryLen;
        }
        if(resolver){
            delete this._binaryContentResolver[id];
            clearTimeout(resolver.timeout);
            resolver.callback(null,binaries);
        }
    }

    private _processTransmit(receiver: string,data: any,dataType: DataType) {
        try {this.onTransmit(receiver,data,dataType)}
        catch(err) {this._onListenerError(err)}
    }

    private _processJsonActionPacket(packet: ActionPacket) {
        switch (packet['0']) {
            case PacketType.Transmit:
                if(typeof packet['1'] !== 'string') return this.onInvalidMessage(new Error('Receiver is not a string.'));
                return this._processData(packet['2'],packet['3'],packet['4'])
                    .then(data => this._processTransmit(packet['1'],data,packet['2']))
                    .catch(this.onInvalidMessage);
            case PacketType.Invoke:
                if(typeof packet['1'] !== 'string') return this.onInvalidMessage(new Error('Receiver is not a string.'));
                if(typeof packet['2'] !== 'number') return this.onInvalidMessage(new Error('CallId is not a number.'));
                return this._processData(packet['3'],packet['4'],packet['5'])
                    .then(data => this._processInvoke(packet['1'],packet['2'],data,packet['3']))
                    .catch(this.onInvalidMessage);
            case PacketType.InvokeDataResp:
                const resp = this._invokeResponsePromises[packet['1']];
                if (resp) {
                    clearTimeout(resp.timeout!);
                    delete this._invokeResponsePromises[packet['1']];
                    return this._processData(packet['2'],packet['3'],packet['4'])
                        .then(data => resp.resolve(resp.returnDataType ? [data,packet['2']] : data))
                        .catch(this.onInvalidMessage);
                }
                return;
            case PacketType.StreamChunk: return this._processJsonStreamChunk(packet['1'],packet['2'],packet['3'],packet['4']);
            case PacketType.StreamDataPermission: return this._processStreamDataPermission(packet['1'],packet['2']);
            case PacketType.StreamEnd: return this._processJsonStreamEnd(packet['1'],packet['2'],packet['3'],packet['4']);
            case PacketType.InvokeErrResp: return this._rejectInvoke(packet['1'],packet['2']);
            case PacketType.ReadStreamClose: return this._processReadStreamClose(packet['1'], packet['2']);
            case PacketType.StreamAccept: return this._processStreamAccept(packet['1'],packet['2']);
            case PacketType.WriteStreamClose: return this._processJsonWriteStreamClose(packet['1'], packet['2']);
            default: return this.onInvalidMessage(new Error('Unknown packet type.'));
        }
    }

    private _rejectInvoke(callId: number, rawErr: any) {
        const resp = this._invokeResponsePromises[callId];
        if (resp) {
            clearTimeout(resp.timeout!);
            delete this._invokeResponsePromises[callId];
            resp.reject(hydrateError(rawErr));
        }
    }

    private _processStreamAccept(streamId: number,bufferSize: number | any) {
        if(typeof bufferSize !== 'number') throw new Error('Invalid buffer size data type to accept a stream.');
        const stream = this._activeWriteStreams[streamId];
        if(stream) stream._open(bufferSize);
    }

    private _processStreamDataPermission(streamId: number,size: number | any) {
        if(typeof size !== 'number') throw new Error('Invalid stream data permission size data type.');
        const stream = this._activeWriteStreams[streamId];
        if(stream) stream._addDataPermission(size);
    }

    private _processReadStreamClose(streamId: number, errorCode?: StreamErrorCloseCode | number) {
        if(typeof errorCode !== 'number' && typeof errorCode !== 'undefined')
            throw new Error('Invalid close code data type to close a stream.');
        const stream = this._activeWriteStreams[streamId];
        if(stream) stream._readStreamClose(errorCode);
    }

    private _processJsonWriteStreamClose(streamId: number, code: StreamErrorCloseCode | number) {
        if(typeof code !== 'number') throw new Error('Invalid close code data type to close a stream.');
        const stream = this._activeReadStreams[streamId];
        if(stream) stream._close(code);
    }

    private _processJsonStreamChunk(streamId: number, dataType: DataType, data: any, binariesPacketId?: number) {
        const stream = this._activeReadStreams[streamId];
        if(stream) {
            if(containsStreams(dataType) && !this.options.chunksCanContainStreams)
                throw new Error('Streams in chunks are not allowed.');
            stream._pushChunk(this._processData(dataType,data,binariesPacketId),dataType);
        }
    }

    private _processJsonStreamEnd(streamId: number, dataType?: DataType, data?: any, binariesPacketId?: number) {
        const stream = this._activeReadStreams[streamId];
        if(stream) {
            if(typeof dataType === 'number') {
                if(containsStreams(dataType) && !this.options.chunksCanContainStreams)
                    throw new Error('Streams in chunks are not allowed.');
                stream._pushChunk(this._processData(dataType,data,binariesPacketId),dataType);
            }
            stream._end();
        }
    }

    private _processBinaryStreamChunk(streamId: number, binary: ArrayBuffer) {
        const stream = this._activeReadStreams[streamId];
        if(stream) stream._pushChunk(binary,DataType.Binary);
    }

    private _processBinaryStreamEnd(streamId: number, binary: ArrayBuffer) {
        const stream = this._activeReadStreams[streamId];
        if(stream) {
            //Binary stream end package chunk is required.
            stream._pushChunk(binary,DataType.Binary);
            stream._end();
        }
    }

    private _processInvoke(procedure: string, callId: number, data: any, dataType: DataType) {
        let called;
        try {
            const badConnectionTimestamp = this.badConnectionTimestamp;
            this.onInvoke(procedure, data,(data, processComplexTypes) => {
                if(called) throw new InvalidActionError('Response ' + callId + ' has already been sent');
                called = true;
                if(badConnectionTimestamp !== this.badConnectionTimestamp) return;
                this._sendInvokeDataResp(callId, data, processComplexTypes);
            }, (err) => {
                if(called) throw new InvalidActionError('Response ' + callId + ' has already been sent');
                called = true;
                if(badConnectionTimestamp !== this.badConnectionTimestamp) return;
                this._send(PacketType.InvokeErrResp + ',' +
                    callId + ',' + (err instanceof JSONString ? JSONString.toString() : encodeJson(dehydrateError(err))));
            },dataType);
        }
        catch(err) {this._onListenerError(err);}
    }

    /**
     * Only use when the connection was not lost in-between time.
     * @param callId
     * @param data
     * @param processComplexTypes
     * @private
     */
    private _sendInvokeDataResp(callId: number, data: any, processComplexTypes?: boolean) {
        if(!processComplexTypes) {
            this._send(PacketType.InvokeDataResp + ',' + callId + ',' +
                DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : ''));
        }
        else if(data instanceof WriteStream && this.options.streamsEnabled){
            const streamId = this._getNewStreamId(data.binary);
            this._send(PacketType.InvokeDataResp + ',' + callId + ',' +
                DataType.Stream + ',' + streamId);
            data._init(this,streamId);
            data._onTransmitted();
        }
        else if(data instanceof ArrayBuffer) {
            const binaryContentPacketId = this._getNewBinaryContentPacketId();
            this._send(PacketType.InvokeDataResp + ',' + callId + ',' +
                DataType.Binary + ',' + binaryContentPacketId);
            this._send(Transport._createBinaryContentPacket(binaryContentPacketId,data),true);
        }
        else {
            const binaries: ArrayBuffer[] = [], streams: WriteStream<any>[] = [];
            data = this._processMixedJSONDeep(data,binaries,streams);

            const pack: Package = [
                PacketType.InvokeDataResp + ',' + callId + ',' +
                parseJSONDataType(binaries.length > 0, streams.length > 0) +
                    (data !== undefined ? (',' + encodeJson(data)) : '')
            ];

            if(binaries.length > 0) {
                const binaryContentPacketId = this._getNewBinaryContentPacketId();
                pack[0] += "," + binaryContentPacketId;
                pack[1] = Transport._createBinaryContentPacket(binaryContentPacketId,binaries);
            }
            if(streams.length > 0)
                pack._afterSend = () => {for(let i = 0; i < streams.length; i++) streams[i]._onTransmitted();}

            this._send(pack[0]);
            if(pack.length > 1) this._send(pack[1]!, true);
        }
    }

    private _processData(type: DataType, data: any, dataMetaInfo: any): Promise<any> {
        if (type === DataType.JSON) return Promise.resolve(data);
        else if (type === DataType.Binary) {
            if(typeof data !== 'number') throw new Error('Invalid binary packet id.');
            return new Promise((res,rej) => {
                this._resolveBinaryContent(data,(err,binaries) => {
                    err ? rej(err) : res(binaries![0])
                });
            })
        } else if (isMixedJSONDataType(type)) {
            const resolveOptions = {
                parseStreams: this.options.streamsEnabled &&
                    (type === DataType.JSONWithStreams || type === DataType.JSONWithStreamsAndBinaries),
                parseBinaries: type === DataType.JSONWithBinaries || type === DataType.JSONWithStreamsAndBinaries
            };
            if(typeof dataMetaInfo === 'number') return new Promise((res,rej) => {
                this._resolveBinaryContent(dataMetaInfo,(err, binaries) => {
                    err ? rej(err) : res(this._resolveMixedJSONDeep(data,resolveOptions,binaries!));
                })
            })
            else return Promise.resolve(this._resolveMixedJSONDeep(data,resolveOptions));
        } else if(type === DataType.Stream && this.options.streamsEnabled) {
            if(typeof data !== 'number') throw new Error('Invalid stream id.');
            return Promise.resolve(new this.options.readStream(data,this));
        }
        else throw new Error('Invalid data type.');
    }

    private _resolveBinaryContent(binariesPacketId: number, callback: (error?: any,binaries?: ArrayBuffer[]) => void) {
        if(this._binaryContentResolver[binariesPacketId]) throw new Error('Binaries resolver already exists.');
        this._binaryContentResolver[binariesPacketId] = {
            callback,
            timeout: setTimeout(() => {
                delete this._binaryContentResolver[binariesPacketId];
                callback(new TimeoutError(`Binaries resolver: ${binariesPacketId} not resolved in time.`,TimeoutType.BinaryResolve));
            }, this.options.binaryResolveTimeout)
        };
    }

    private _resolveMixedJSONDeep(data: any,
                                  options: {parseStreams: boolean, parseBinaries: boolean},
                                  binaries?: ArrayBuffer[]): Promise<any>
    {
        const wrapper = [data];
        this._internalResolveMixedJSONDeep(wrapper, 0, options, {binaries, streamCount: 0});
        return wrapper[0];
    }

    private _internalResolveMixedJSONDeep(obj: any, key: any,
                                  options: {parseStreams: boolean, parseBinaries: boolean},
                                  meta: {
                                    binaries?: ArrayBuffer[],
                                    streamCount: number
                                  }): any
    {
        const value = obj[key];
        if(typeof value === 'object' && value) {
            if(Array.isArray(value)) {
                const len = value.length;
                for (let i = 0; i < len; i++)
                    this._internalResolveMixedJSONDeep(value,i,options,meta);
            }
            else  {
                if(options.parseBinaries && typeof value['_b'] === 'number') {
                    if(!meta.binaries) throw new Error('Can not resolve binary data without binary content packet.');
                    obj[key] = meta.binaries[value['_b']];
                }
                else if(options.parseStreams && typeof value['_s'] === 'number'){
                    if(meta.streamCount >= this.options.streamsPerPacketLimit) throw new Error('Max stream limit reached.')
                    meta.streamCount++;
                    obj[key] = new this.options.readStream(value['_s'],this);
                }
                else {
                    const clone = {};
                    let unescapedKey: string;
                    for(const key in value) {
                        unescapedKey = unescapePlaceholderSequence(key);
                        clone[unescapedKey] = value[key];
                        this._internalResolveMixedJSONDeep(clone,unescapedKey,options,meta);
                    }
                    obj[key] = clone;
                }
            }
        }
    }

    private static _createBinaryContentPacket(refId: number, content: ArrayBuffer | ArrayBuffer[]): ArrayBuffer {
        if(content instanceof ArrayBuffer) {
            if(content.byteLength > MAX_SUPPORTED_ARRAY_BUFFER_SIZE)
                throw new MaxSupportedArrayBufferSizeExceededError(content);

            const packetBuffer = new DataView(new ArrayBuffer(13 + content.byteLength));
            const uint8PacketView = new Uint8Array(packetBuffer.buffer);
            packetBuffer.setInt8(0,PacketType.BinaryContent);
            packetBuffer.setFloat64(1,refId);
            packetBuffer.setUint32(9,content.byteLength);
            uint8PacketView.set(new Uint8Array(content),13);
            return packetBuffer.buffer;
        }
        else {
            const len = content.length;

            //Calculate size
            let size = 9 + len * 4, i, bi, item: ArrayBuffer;
            for(i = 0; i < len; i++) size += content[i].byteLength;

            const packetBuffer = new DataView(new ArrayBuffer(size));
            const uint8PacketView = new Uint8Array(packetBuffer.buffer);
            packetBuffer.setInt8(0,PacketType.BinaryContent);
            packetBuffer.setFloat64(1,refId);
            for(i = 0, bi = 9; i < len; i++) {
                item = content[i];
                if(item.byteLength > MAX_SUPPORTED_ARRAY_BUFFER_SIZE)
                    throw new MaxSupportedArrayBufferSizeExceededError(item);
                packetBuffer.setUint32(bi,item.byteLength);
                uint8PacketView.set(new Uint8Array(item),bi+=4);
                bi += item.byteLength;
            }
            return packetBuffer.buffer;
        }
    }

    private _processMixedJSONDeep(data: any, binaries: ArrayBuffer[], streams: WriteStream<any>[]) {
        if(typeof data === 'object' && data){
            if(data instanceof ArrayBuffer) return {_b: binaries.push(data) - 1};
            else if(data instanceof WriteStream){
                if(this.options.streamsEnabled){
                    const streamId = this._getNewStreamId(data.binary);
                    data._init(this,streamId);
                    streams.push(data);
                    return {_s: streamId}
                }
                else return data.toJSON();
            }
            else if(Array.isArray(data)) {
                const newArray: any[] = [], len = data.length;
                for (let i = 0; i < len; i++)
                    newArray[i] = this._processMixedJSONDeep(data[i], binaries, streams);
                return newArray;
            }
            else if(!(data instanceof Date)) {
                const clone = {};
                for(const key in data) {
                    // noinspection JSUnfilteredForInLoop
                    clone[escapePlaceholderSequence(key)] = this._processMixedJSONDeep(data[key], binaries, streams);
                }
                return clone;
            }
        }
        return data;
    }

    private _rejectBinaryContentResolver(err: Error) {
        let resolver: BinaryContentResolver;
        for(const k in this._binaryContentResolver) {
            if(this._binaryContentResolver.hasOwnProperty(k)){
                resolver = this._binaryContentResolver[k];
                clearTimeout(resolver.timeout);
                resolver.callback(err);
            }
        }
        this._binaryContentResolver = {};
    }

    private _emitBadConnectionToStreams() {
        for (const k in this._activeReadStreams) {
            if (this._activeReadStreams.hasOwnProperty(k))
                this._activeReadStreams[k]._emitBadConnection();
        }
        for (const k in this._activeWriteStreams) {
            if (this._activeWriteStreams.hasOwnProperty(k))
                this._activeWriteStreams[k]._emitBadConnection();
        }
    }

    /**
     * @internal
     * @param id
     * @param stream
     * @private
     */
    _addReadStream(id: number, stream: ReadStream) {
        this._activeReadStreams[id] = stream;
    }

    /**
     * @internal
     * @param id
     * @param stream
     * @private
     */
    _addWriteStream(id: number, stream: WriteStream<any>) {
        this._activeWriteStreams[id] = stream;
    }

    /**
     * @internal
     * @private
     * @param id
     */
    _removeWriteStream(id: number) {
        delete this._activeWriteStreams[id];
    }

    /**
     * @internal
     * @param id
     * @private
     */
    _removeReadStream(id: number) {
        delete this._activeReadStreams[id];
    }

    //Send
    /**
     * Notice that the package can not send multiple times.
     * If you need this you can check out the static method prepareMultiTransmit.
     * Also after preparing you should not send millions of other
     * packages before sending the created package.
     * It is perfect to prepare packages when the connection
     * is lost and send them when the socket is connected again.
     * @param receiver
     * It should not contain double-quotes.
     * To be sure, you can use the escapeJSONString function.
     * @param data
     * @param processComplexTypes
     */
    prepareTransmit(receiver: string, data?: any, {processComplexTypes}: ComplexTypesOption = {}): Package {
        if(!processComplexTypes) {
            return [PacketType.Transmit + ',"' + receiver + '",' +
            DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : '')];
        }
        else if(data instanceof WriteStream && this.options.streamsEnabled){
            const streamId = this._getNewStreamId(data.binary);
            const packet: Package = [PacketType.Transmit + ',"' + receiver + '",' +
                DataType.Stream + ',' + streamId];
            data._init(this,streamId);
            packet._afterSend = () => data._onTransmitted();
            return packet;
        }
        else if(data instanceof ArrayBuffer) {
            const binaryContentPacketId = this._getNewBinaryContentPacketId();
            return [PacketType.Transmit + ',"' + receiver + '",' +
                DataType.Binary + ',' + binaryContentPacketId,
                Transport._createBinaryContentPacket(binaryContentPacketId,data)];
        }
        else {
            const binaries: ArrayBuffer[] = [], streams: WriteStream<any>[] = [];
            data = this._processMixedJSONDeep(data,binaries,streams);

            const pack: Package = [
                PacketType.Transmit + ',"' + receiver + '",' +
                parseJSONDataType(binaries.length > 0,streams.length > 0) +
                (data !== undefined ? (',' + encodeJson(data)) : '')
            ];

            if(binaries.length > 0) {
                const binaryContentPacketId = this._getNewBinaryContentPacketId();
                pack[0] += "," + binaryContentPacketId;
                pack[1] = Transport._createBinaryContentPacket(binaryContentPacketId,binaries);
            }
            if(streams.length > 0)
                pack._afterSend = () => {for(let i = 0; i < streams.length; i++) streams[i]._onTransmitted();}
            return pack;
        }
    }

    /**
     * Notice that the package can not send multiple times.
     * Also after preparing you should not send millions of other
     * packages before sending the created package.
     * It is perfect to prepare packages when the connection
     * is lost and send them when the socket is connected again.
     * @param procedure
     * It should not contain double-quotes.
     * To be sure, you can use the escapeJSONString function.
     * @param data
     * @param ackTimeout
     * @param processComplexTypes
     * @param returnDataType
     */
    prepareInvoke<RDT extends true | false | undefined>(
        procedure: string,
        data?: any,
        {ackTimeout,processComplexTypes,returnDataType}: {ackTimeout?: number | null, returnDataType?: RDT} & ComplexTypesOption = {}
        ): InvokePackage<RDT extends true ? [any,DataType] : any>
    {
        const callId = this._getNewCid();
        const pack: InvokePackage = [] as any;

        if(!processComplexTypes) {
            pack.promise = new Promise<any>((resolve, reject) => {
                pack._afterSend = () => {
                    this._invokeResponsePromises[callId] = returnDataType ? {resolve, reject, returnDataType} : {resolve, reject};
                    this._invokeResponsePromises[callId].timeout = setTimeout(() => {
                        delete this._invokeResponsePromises[callId];
                        reject(new TimeoutError(`Response for call id: "${callId}" timed out`,TimeoutType.InvokeResponse));
                    }, ackTimeout || this.options.ackTimeout);
                }
            });
            pack[0] = PacketType.Invoke + ',"' + procedure + '",' + callId + ',' +
                DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : '');
            return pack;
        }
        else {
            let setResponse: (() => void) | undefined = undefined;
            let setResponseTimeout: (() => void) | undefined = undefined;
            pack.promise = new Promise<any>((resolve, reject) => {
                setResponse = () => {
                    this._invokeResponsePromises[callId] = returnDataType ? {resolve, reject, returnDataType} : {resolve, reject};
                }
                setResponseTimeout = () => {
                    if(this._invokeResponsePromises[callId] && this._invokeResponsePromises[callId].timeout === undefined)
                        this._invokeResponsePromises[callId].timeout = setTimeout(() => {
                            delete this._invokeResponsePromises[callId];
                            reject(new TimeoutError(`Response for call id: "${callId}" timed out`,TimeoutType.InvokeResponse));
                        }, ackTimeout || this.options.ackTimeout);
                }
            });

            if(data instanceof WriteStream && this.options.streamsEnabled){
                const sent = new Promise(res => pack._afterSend = () => {
                    setResponse!();
                    res();
                    (data as WriteStream<any>)._onTransmitted();
                });
                const streamId = this._getNewStreamId(data.binary);
                pack[0] = PacketType.Invoke + ',"' + procedure + '",' + callId + ',' +
                    DataType.Stream + ',' + streamId;
                Promise.all([sent,data.closed]).then(setResponseTimeout);
                data._init(this,streamId);
                return pack;
            }
            else if(data instanceof ArrayBuffer) {
                pack._afterSend = () => {
                    setResponse!();
                    setResponseTimeout!();
                }
                const binaryContentPacketId = this._getNewBinaryContentPacketId();
                pack[0] = PacketType.Invoke + ',"' + procedure + '",' + callId + ',' +
                    DataType.Binary + ',' + binaryContentPacketId;
                pack[1] = Transport._createBinaryContentPacket(binaryContentPacketId,data);
                return pack;
            }
            else {
                const binaries: ArrayBuffer[] = [], streams: WriteStream<any>[] = [];
                data = this._processMixedJSONDeep(data,binaries,streams);

                if(streams.length > 0) {
                    const sent = new Promise(res => pack._afterSend = () => {
                        setResponse!();
                        res();
                        for(let i = 0; i < streams.length; i++) streams[i]._onTransmitted();
                    });
                    Promise.all([sent,...streams.map(stream => stream.closed)]).then(setResponseTimeout);
                }
                else pack._afterSend = () => {
                    setResponse!();
                    setResponseTimeout!();
                }

                pack[0] = PacketType.Invoke + ',"' + procedure + '",' + callId + ',' +
                    parseJSONDataType(binaries.length > 0,streams.length > 0) +
                    (data !== undefined ? (',' + encodeJson(data)) : '');

                if(binaries.length > 0) {
                    const binaryContentPacketId = this._getNewBinaryContentPacketId();
                    pack[0] += "," + binaryContentPacketId;
                    pack[1] = Transport._createBinaryContentPacket(binaryContentPacketId,binaries);
                }

                return pack;
            }
        }
    }

    // noinspection JSUnusedGlobalSymbols
    sendPackage(pack: Package, batch?: number | true | null): void {
        if(!this.open) this.buffer.add(pack);
        else if(batch) this.buffer.add(pack,batch);
        else this._directSendPackage(pack);
    }

    // noinspection JSUnusedGlobalSymbols
    sendPackageWithPromise(pack: Package, batch?: number | true | null): Promise<void> {
        if(batch) {
            return new Promise((resolve) => {
                const tmpAfterSend = pack._afterSend;
                pack._afterSend = () => {
                    if(tmpAfterSend) tmpAfterSend();
                    resolve();
                }
                this.buffer.add(pack,batch);
            })
        }
        else if(this.open) return this._directSendPackage(pack), RESOLVED_PROMISE;
        else return new Promise((resolve) => {
            const tmpAfterSend = pack._afterSend;
            pack._afterSend = () => {
                if(tmpAfterSend) tmpAfterSend();
                resolve();
            }
            this.buffer.add(pack);
        })
    }

    // noinspection JSUnusedGlobalSymbols
    invoke<RDT extends true | false | undefined>(procedure: string, data?: any, options:
        {ackTimeout?: number, batch?: number | true | null,returnDataType?: RDT} & ComplexTypesOption = {}):
        Promise<RDT extends true ? [any,DataType] : any>
    {
        const prePackage = this.prepareInvoke(procedure,data,options);
        this.sendPackage(prePackage,options.batch);
        return prePackage.promise;
    }

    // noinspection JSUnusedGlobalSymbols
    transmit(receiver: string, data?: any, options: {batch?: number | true | null} & ComplexTypesOption = {}) {
        this.sendPackage(this.prepareTransmit(receiver,data,options),options.batch);
    }

    // noinspection JSUnusedGlobalSymbols
    sendPing() {
        try {this._send(PING_BINARY,true);}
        catch (_) {}
    }

    // noinspection JSUnusedGlobalSymbols
    sendPong() {
        try {this._send(PONG_BINARY,true);}
        catch (_) {}
    }

    private _directSendPackage(pack: Package) {
        this._send(pack[0])
        if(pack.length > 1) this._send(pack[1]!,true);
        if(pack._afterSend) pack._afterSend();
    }

    /**
     * Only use when the connection was not lost in-between time.
     * It sends the chunk directly.
     * @internal
     * @param streamId
     * @param data
     * @param processComplexTypes
     * @param end
     * @private
     */
    _sendStreamChunk(streamId: number, data: any, processComplexTypes?: boolean, end?: boolean) {
        if(!processComplexTypes) {
            this._send((end ? PacketType.StreamEnd : PacketType.StreamChunk) +
                ',' + streamId + ',' + DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : ''));
        }
        else if(this.options.chunksCanContainStreams && data instanceof WriteStream){
            const streamId = this._getNewStreamId(data.binary);
            this._send((end ? PacketType.StreamEnd : PacketType.StreamChunk) +
                ',' + streamId + ',' + DataType.Stream + ',' + streamId);
            data._init(this,streamId);
            data._onTransmitted();
        }
        else if(data instanceof ArrayBuffer)
            this._send(Transport._createBinaryStreamChunkPacket(streamId,new Uint8Array(data),end),true);
        else {
            const binaries: ArrayBuffer[] = [], streams: WriteStream<any>[] = [];
            data = this._processMixedJSONDeep(data,binaries,streams);

            const pack: Package = [
                (end ? PacketType.StreamEnd : PacketType.StreamChunk) +
                ',' + streamId + ',' + parseJSONDataType(binaries.length > 0 || streams.length > 0) +
                (data !== undefined ? (',' + encodeJson(data)) : '')
            ];

            if(binaries.length > 0) {
                const binaryContentPacketId = this._getNewBinaryContentPacketId();
                pack[0] += "," + binaryContentPacketId;
                pack[1] = Transport._createBinaryContentPacket(binaryContentPacketId,binaries);
            }

            this._send(pack[0]);
            if(pack.length > 1) this._send(pack[1]!,true);
            for(let i = 0; i < streams.length; i++) streams[i]._onTransmitted();
        }
    }

    /**
     * @internal
     * @description
     * Useful to send a binary stream chunk
     * packet directly (faster than using _sendStreamChunk).
     */
    _sendBinaryStreamChunk(streamId: number, binaryPart: Uint8Array, end?: boolean) {
        this._send(Transport._createBinaryStreamChunkPacket(streamId,binaryPart,end),true)
    }

    /**
     * @internal
     * @description
     * Sends a stream end without any data.
     * @param streamId
     */
    _sendStreamEnd(streamId: number) {
        this._send(PacketType.StreamEnd + ',' + streamId);
    }

    private static _createBinaryStreamChunkPacket(streamId: number, binary: Uint8Array, end?: boolean): ArrayBuffer {
        const packetBuffer = new Uint8Array(9 + binary.byteLength);
        packetBuffer[0] = end ? PacketType.StreamEnd : PacketType.StreamChunk;
        packetBuffer.set(new Uint8Array((new Float64Array([streamId])).buffer),1);
        packetBuffer.set(binary,9);
        return packetBuffer.buffer;
    }

    /**
     * Only use when the connection was not lost in-between time.
     * @internal
     * @param streamId
     * @param allowedSize
     * @private
     */
    _sendStreamAccept(streamId: number,allowedSize: number) {
        this._send(PacketType.StreamAccept + ',' + streamId + ',' + allowedSize);
    }

    /**
     * Only use when the connection was not lost in-between time.
     * @internal
     * @param streamId
     * @param allowedSize
     * @private
     */
    _sendStreamAllowMore(streamId: number,allowedSize: number) {
        this._send(PacketType.StreamDataPermission + ',' + streamId + ',' + allowedSize);
    }

    /**
     * Only use when the connection was not lost in-between time.
     * @internal
     * @param streamId
     * @param errorCode
     * @private
     */
    _sendReadStreamClose(streamId: number, errorCode?: number) {
        this._send(PacketType.ReadStreamClose + ',' + streamId +
            (errorCode != null ? (',' + errorCode) : ''));
    }

    /**
     * Only use when the connection was not lost in-between time.
     * @internal
     * @param streamId
     * @param errorCode
     * @private
     */
    _sendWriteStreamClose(streamId: number, errorCode: number) {
        this._send(PacketType.WriteStreamClose + ',' + streamId + ',' + errorCode);
    }

    /**
     * @description
     * Tries to cancel a package sent if it is not already sent.
     * The returned boolean indicates if it was successfully cancelled.
     * @param pack
     */
    public tryCancelPackage(pack: Package): boolean {
        return this.buffer.tryRemove(pack);
    }

    /**
     * @internal
     */
    public toJSON() {
        return '[Transport]';
    }

    //Multi transport

    private static _multiBinaryContentPacketId: number = -1;

    private static _getNewMultiBinaryContentPacketId() {
        if(Transport._multiBinaryContentPacketId < Number.MIN_SAFE_INTEGER) Transport._multiBinaryContentPacketId = -1;
        return Transport._multiBinaryContentPacketId--;
    }

    /**
     * @description
     * Creates a transmit package that can be sent to multiple transporters
     * but not multiple times to the same transport (except there is no binary data in the package).
     * This is extremely efficient when sending to a lot of transporters.
     * Notice that streams are not supported but binaries are supported.
     * After preparing you should not wait a long time to send the package to the targets.
     * @param receiver
     * It should not contain double-quotes.
     * To be sure, you can use the escapeJSONString function.
     * @param data
     * @param processComplexTypes
     */
    public static prepareMultiTransmit(receiver: string, data?: any, {processComplexTypes}: ComplexTypesOption = {}): Package {
        if(!processComplexTypes) {
            return [PacketType.Transmit + ',"' + receiver + '",' +
                DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : '')];
        }
        else if(data instanceof ArrayBuffer) {
            const binaryContentPacketId = Transport._getNewMultiBinaryContentPacketId();
            return [PacketType.Transmit + ',"' + receiver + '",' +
                DataType.Binary + ',' + binaryContentPacketId,
                Transport._createBinaryContentPacket(binaryContentPacketId,data)];
        }
        else {
            const binaries: ArrayBuffer[] = [];
            data = Transport._processMultiMixedJSONDeep(data,binaries);
            const pack: Package = [
                PacketType.Transmit + ',"' + receiver + '",' +
                parseJSONDataType(binaries.length > 0,false) +
                (data !== undefined ? (',' + encodeJson(data)) : '')
            ];
            if(binaries.length > 0) {
                const binaryContentPacketId = Transport._getNewMultiBinaryContentPacketId();
                pack[0] += "," + binaryContentPacketId;
                pack[1] = Transport._createBinaryContentPacket(binaryContentPacketId,binaries);
            }
            return pack;
        }
    }

    private static _processMultiMixedJSONDeep(data: any, binaries: ArrayBuffer[]) {
        if(typeof data === 'object' && data){
            if(data instanceof ArrayBuffer) return {_b: binaries.push(data) - 1};
            else if(Array.isArray(data)) {
                const newArray: any[] = [], len = data.length;
                for (let i = 0; i < len; i++)
                    newArray[i] = Transport._processMultiMixedJSONDeep(data[i],binaries);
                return newArray;
            }
            else if(!(data instanceof Date)) {
                const clone = {};
                for(const key in data) {
                    // noinspection JSUnfilteredForInLoop
                    clone[escapePlaceholderSequence(key)] = Transport._processMultiMixedJSONDeep(data[key],binaries);
                }
                return clone;
            }
        }
        return data;
    }

}