/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import {ActionPacket, BundlePacket, PacketType,} from "./Protocol";
import {containsStreams, DataType, isMixedJSONDataType, parseJSONDataType} from "./DataType";
import {dehydrateError, hydrateError} from "./ErrorUtils";
import {decodeJson, encodeJson, JSONString} from "./JsonUtils";
import ReadStream from "./streams/ReadStream";
import WriteStream from "./streams/WriteStream";
import {StreamErrorCloseCode} from "./streams/StreamErrorCloseCode";
import {RESOLVED_PROMISE, Writable} from "./Utils";
import {BadConnectionError, BadConnectionType, InvalidActionError, TimeoutError, TimeoutType} from "./Errors";

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

/**
 * A prepared package contains prepared or multiple packets.
 */
export type PreparedPackage = (string | ArrayBuffer)[] & {
    /**
     * @description
     * Used to set the ack timeout.
     * @internal
     */
    _afterSend?: () => void;
};

type PreparedInvokePackage<T = any> = PreparedPackage & {
    promise: Promise<T>
}

const PING = 57;
const PING_BINARY = new Uint8Array([PING]);

const PONG = 65;
const PONG_BINARY = new Uint8Array([PONG]);

export default class Transport {

    /**
     * The read stream class that is used.
     * Must inherit from the Ziron ReadStream.
     */
    public static readStream: typeof ReadStream = ReadStream;

    public ackTimeout?: number;
    public limitBatchPackageLength: number = Transport.limitBatchPackageLength;
    public maxBufferChunkLength?: number;

    public static ackTimeout: number = 10000;
    public static limitBatchPackageLength: number = 310000;
    public static maxBufferChunkLength: number = 200;
    public static binaryResolveTimeout: number = 10000;
    public static packetBinaryResolverLimit: number = 40;
    public static packetStreamLimit: number = 20;
    public static streamsEnabled: boolean = true;
    public static chunksCanContainStreams: boolean = false;

    public onInvalidMessage: (err: Error) => void;
    /**
     * @description
     * Is called whenever one of the listeners
     * (onTransmit, onInvoke, onPing) have thrown an error.
     */
    public onListenerError: (err: Error) => void;
    public onTransmit: TransmitListener;
    public onInvoke: InvokeListener;
    public onPing: () => void;
    public onPong: () => void;
    public send: (msg: string | ArrayBuffer) => void;

    public readonly badConnectionTimestamp: number = -1;

    constructor(connector: {
        onInvalidMessage?: (err: Error) => void;
        onListenerError?: (err: Error) => void;
        onTransmit?: TransmitListener;
        onInvoke?: InvokeListener;
        onPing?: () => void;
        onPong?: () => void;
        send?: (msg: string | ArrayBuffer) => void;
    } = {}, open: boolean = true) {
        this.onInvalidMessage = connector.onInvalidMessage || (() => {});
        this.onListenerError = connector.onListenerError || (() => {});
        this.onTransmit = connector.onTransmit || (() => {});
        this.onInvoke = connector.onInvoke || (() => {});
        this.onPing = connector.onPing || (() => {});
        this.onPong = connector.onPong || (() => {});
        this.send = connector.send || (() => {});
        this._open = open;
    }

    /**
     * Can not be reset on connection lost
     * because prepared packets with old ids can exist.
     */
    private _binaryPlaceHolderId: number = 0;
    private _binaryResolver: Record<number,{resolve: (binary: ArrayBuffer) => void,reject: (err: any) => void,timeout: NodeJS.Timeout}> = {};

    private static _binaryMultiPlaceHolderId: number = -1;

    /**
     * Can not be reset on connection lost
     * because prepared packets with old ids can exist.
     */
    private _objectStreamId: number = 1;
    private _binaryStreamId: number = -1;
    private _activeReadStreams: Record<string, ReadStream> = {};
    private _activeWriteStreams: Record<string, WriteStream> = {};

    /**
     * Can not be reset on connection lost
     * because prepared packets with old ids can exist.
     */
    private _cid: number = 0;
    private _invokeResponsePromises: Record<number,
        {
            resolve: (data: any) => void,
            reject: (err: any) => void,
            timeout?: NodeJS.Timeout,
            returnDataType?: boolean
        }> = {};

    private _open: boolean = true;

    private _buffer: PreparedPackage[] = [];
    private _bufferTimeoutDelay: number | undefined;
    private _bufferTimeoutTicker: NodeJS.Timeout | undefined;
    private _bufferTimeoutTimestamp: number | undefined;

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
                                this._processJsonActionPacket(packets[i])
                                    .catch(this.onInvalidMessage);
                            }
                        }
                    }
                    else this._processJsonActionPacket(packet).catch(this.onInvalidMessage);
                }
            }
        }
        catch(e){this.onInvalidMessage(e);}
    }

    emitBadConnection(type: BadConnectionType,msg?: string) {
        this._open = false;
        this._clearBufferTimeout();
        const err = new BadConnectionError(type,msg);
        (this as Writable<Transport>).badConnectionTimestamp = Date.now();
        this._clearBinaryResolver();
        this._rejectInvokeRespPromises(err);
        this._emitBadConnectionToStreams();
        this._activeReadStreams = {};
        this._activeWriteStreams = {};
    }

    emitOpen() {
        this._open = true;
        this._flushBuffer();
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

    private _getNewBinaryPlaceholderId() {
        if(this._binaryPlaceHolderId > Number.MAX_SAFE_INTEGER) this._binaryPlaceHolderId = 0;
        return this._binaryPlaceHolderId++;
    }

    private static _getNewBinaryMultiPlaceholderId() {
        if(Transport._binaryMultiPlaceHolderId < Number.MIN_SAFE_INTEGER) Transport._binaryMultiPlaceHolderId = -1;
        return Transport._binaryMultiPlaceHolderId--;
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
        if(header === PacketType.BinaryReference) {
            const id = (new Float64Array(buffer.slice(1,9)))[0];
            const resolver = this._binaryResolver[id];
            if(resolver){
                delete this._binaryResolver[id];
                clearTimeout(resolver.timeout);
                resolver.resolve(buffer.slice(9));
            }
        }
        else if(header === PacketType.StreamChunk)
            this._processBinaryStreamChunk((new Float64Array(buffer.slice(1,9)))[0],buffer.slice(9));
        else if(header === PacketType.StreamEnd)
            this._processBinaryStreamEnd((new Float64Array(buffer.slice(1,9)))[0],buffer.slice(9));
        else this.onInvalidMessage(new Error('Unknown binary package header type.'))
    }

    private _processTransmit(receiver: string,data: any,dataType: DataType) {
        try {this.onTransmit(receiver,data,dataType)}
        catch(err) {this._onListenerError(err)}
    }

    private async _processJsonActionPacket(packet: ActionPacket) {
        switch (packet['0']) {
            case PacketType.Transmit:
                if(typeof packet['1'] !== 'string') return this.onInvalidMessage(new Error('Receiver is not a string.'));
                return this._processTransmit(packet['1'],await this._processData(packet['2'],packet['3']),packet['2']);
            case PacketType.Invoke:
                if(typeof packet['1'] !== 'string') return this.onInvalidMessage(new Error('Receiver is not a string.'));
                if(typeof packet['2'] !== 'number') return this.onInvalidMessage(new Error('CallId is not a number.'));
                return this._processInvoke(this.onInvoke,packet['1'],packet['2'],
                    await this._processData(packet['3'],packet['4']),packet['3'])
            case PacketType.InvokeDataResp:
                const resp = this._invokeResponsePromises[packet['1']];
                if (resp) {
                    clearTimeout(resp.timeout!);
                    delete this._invokeResponsePromises[packet['1']];
                    return resp.resolve(resp.returnDataType ?
                        [await this._processData(packet['2'],packet['3']),packet['2']] :
                        await this._processData(packet['2'],packet['3']));
                }
                return;
            case PacketType.StreamChunk: return this._processJsonStreamChunk(packet['1'],packet['2'],packet['3']);
            case PacketType.StreamDataPermission: return this._processStreamDataPermission(packet['1'],packet['2']);
            case PacketType.StreamEnd: return this._processJsonStreamEnd(packet['1'],packet['2'],packet['3']);
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

    private _processJsonStreamChunk(streamId: number, dataType: DataType, data: any) {
        const stream = this._activeReadStreams[streamId];
        if(stream) {
            if(containsStreams(dataType) && !Transport.chunksCanContainStreams)
                throw new Error('Streams in chunks are not allowed.');
            stream._pushChunk(this._processData(dataType,data),dataType);
        }
    }

    private _processJsonStreamEnd(streamId: number, dataType?: DataType, data?: any) {
        const stream = this._activeReadStreams[streamId];
        if(stream) {
            if(typeof dataType === 'number') {
                if(containsStreams(dataType) && !Transport.chunksCanContainStreams)
                    throw new Error('Streams in chunks are not allowed.');
                stream._pushChunk(this._processData(dataType,data),dataType);
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

    private _processInvoke(caller: InvokeListener, procedure: string, callId: number, data: any, dataType: DataType) {
        let called;
        try {
            const badConnectionTimestamp = this.badConnectionTimestamp;
            caller(procedure, data,(data, processComplexTypes) => {
                if(called) throw new InvalidActionError('Response ' + callId + ' has already been sent');
                called = true;
                if(badConnectionTimestamp !== this.badConnectionTimestamp) return;
                this._sendInvokeDataResp(callId, data, processComplexTypes);
            }, (err) => {
                if(called) throw new InvalidActionError('Response ' + callId + ' has already been sent');
                called = true;
                if(badConnectionTimestamp !== this.badConnectionTimestamp) return;
                this.send(PacketType.InvokeErrResp + ',' +
                    callId + ',' + (err instanceof JSONString ? JSONString.toString() : encodeJson(dehydrateError(err)))
                );
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
            this.send(PacketType.InvokeDataResp + ',' + callId + ',' +
                DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : ''));
        }
        else if(data instanceof WriteStream && Transport.streamsEnabled){
            const streamId = this._getNewStreamId(data.binary);
            this.send(PacketType.InvokeDataResp + ',' + callId + ',' +
                DataType.Stream + ',' + streamId);
            data._init(this,streamId);
            data._onTransmitted();
        }
        else if(data instanceof ArrayBuffer) {
            const binaryId = this._getNewBinaryPlaceholderId();
            this.send(PacketType.InvokeDataResp + ',' + callId + ',' +
                DataType.Binary + ',' + binaryId);
            this.send(Transport._createBinaryReferencePacket(binaryId,data));
        }
        else {
            const preparedPackage: PreparedPackage = [] as any;
            const streams: WriteStream<any>[] = [];
            preparedPackage.length = 1;
            data = this._processMixedJSONDeep(data,preparedPackage,streams);

            if(streams.length > 0)
                preparedPackage._afterSend = () => {for(let i = 0; i < streams.length; i++) streams[i]._onTransmitted();}

            preparedPackage[0] = PacketType.InvokeDataResp + ',' + callId + ',' +
                parseJSONDataType(preparedPackage.length > 1, streams.length > 0) +
                (data !== undefined ? (',' + encodeJson(data)) : '');
            for(let i = 0; i < preparedPackage.length; i++) this.send(preparedPackage[i])
        }
    }

    private _processData(type: DataType, data: any): Promise<any> | any {
        if (type === DataType.JSON) return data;
        else if (type === DataType.Binary) {
            if(typeof data !== 'number') throw new Error('Invalid binary placeholder type.');
            return this._createBinaryResolver(data);
        } else if (isMixedJSONDataType(type)) {
            const promises: Promise<any>[] = [];
            const wrapper = [data];
            this._resolveMixedJSONDeep(wrapper, 0, promises, {
                parseStreams: Transport.streamsEnabled &&
                    (type === DataType.JSONWithStreams || type === DataType.JSONWithStreamsAndBinary),
                parseBinaries: type === DataType.JSONWithBinaries || type === DataType.JSONWithStreamsAndBinary
            });
            return new Promise(async resolve => {
                await Promise.all(promises);
                resolve(wrapper[0]);
            });
        } else if(type === DataType.Stream && Transport.streamsEnabled) {
            if(typeof data !== 'number') throw new Error('StreamId is not a number.');
            return new Transport.readStream(data,this);
        }
        else throw new Error('Invalid data type.');
    }

    private _createBinaryResolver(id: number): Promise<ArrayBuffer> {
        if(this._binaryResolver[id]) throw new Error('Binary placeholder already exists.');
        return new Promise<ArrayBuffer>((resolve, reject) => {
            this._binaryResolver[id] = {
                resolve,
                reject,
                timeout: setTimeout(() => {
                    delete this._binaryResolver[id];
                    reject(new TimeoutError(`Binary placeholder: ${id} not resolved in time.`,TimeoutType.BinaryResolve));
                }, Transport.binaryResolveTimeout)
            };
        });
    }

    private _resolveMixedJSONDeep(obj: any, key: any, binaryResolverPromises: Promise<any>[],
                                  options: {parseStreams: boolean, parseBinaries: boolean},
                                  meta: {streamCount:  number} = {streamCount: 0}): any
    {
        const value = obj[key];
        if(typeof value === 'object' && value) {
            if(Array.isArray(value)) {
                const len = value.length;
                for (let i = 0; i < len; i++) this._resolveMixedJSONDeep(value, i, binaryResolverPromises, options);
            }
            else  {
                if(options.parseBinaries && typeof value['__binary__'] === 'number'){
                    if(binaryResolverPromises.length >= Transport.packetBinaryResolverLimit)
                        throw new Error('Max binary resolver limit reached.')
                    binaryResolverPromises.push(new Promise(async (resolve) => {
                        // noinspection JSUnfilteredForInLoop
                        obj[key] = await this._createBinaryResolver(value['__binary__']);
                        resolve();
                    }));
                }
                else if(options.parseStreams && typeof value['__stream__'] === 'number'){
                    if(meta.streamCount >= Transport.packetStreamLimit)
                        throw new Error('Max stream limit reached.')
                    meta.streamCount++;
                    obj[key] = new Transport.readStream(value['__stream__'],this);
                }
                else for(const key in value) this._resolveMixedJSONDeep(value, key, binaryResolverPromises, options);
            }
        }
    }

    private static _createBinaryReferencePacket(id: number, binary: ArrayBuffer): ArrayBuffer {
        const packetBuffer = new Uint8Array(9 + binary.byteLength);
        packetBuffer[0] = PacketType.BinaryReference;
        packetBuffer.set(new Uint8Array((new Float64Array([id])).buffer),1);
        packetBuffer.set(new Uint8Array(binary),9);
        return packetBuffer.buffer;
    }

    private _processMixedJSONDeep(data: any, binaryReferencePackets: any[], streams: WriteStream<any>[]) {
        if(typeof data === 'object' && data){
            if(data instanceof ArrayBuffer){
                const placeholderId = this._getNewBinaryPlaceholderId();
                binaryReferencePackets.push(Transport._createBinaryReferencePacket(placeholderId, data));
                return {__binary__: placeholderId};
            }
            else if(data instanceof WriteStream){
                if(Transport.streamsEnabled){
                    const streamId = this._getNewStreamId(data.binary);
                    data._init(this,streamId);
                    streams.push(data);
                    return {__stream__: streamId}
                }
                else return data.toJSON();
            }
            else if(Array.isArray(data)) {
                const newArray: any[] = [];
                const len = data.length;
                for (let i = 0; i < len; i++) {
                    newArray[i] = this._processMixedJSONDeep(data[i], binaryReferencePackets, streams);
                }
                return newArray;
            }
            else if(!(data instanceof Date)) {
                const clone = {};
                for(const key in data) {
                    // noinspection JSUnfilteredForInLoop
                    clone[key] = this._processMixedJSONDeep(data[key], binaryReferencePackets, streams);
                }
                return clone;
            }
        }
        return data;
    }

    private _clearBinaryResolver() {
        for(const k in this._binaryResolver) {
            if(this._binaryResolver.hasOwnProperty(k)){
                clearTimeout(this._binaryResolver[k].timeout);
            }
        }
        this._binaryResolver = {};
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
    // noinspection JSMethodCanBeStatic
    private compressPreparedPackages(preparedPackets: PreparedPackage[]): PreparedPackage {
        const binaryPackets: PreparedPackage = [], stringPackets: string[] = [], len = preparedPackets.length;
        let tmpStringPacket = '', tmpPackets: PreparedPackage;

        for(let i = 0; i < len; i++) {
            tmpPackets = preparedPackets[i];
            for(let j = 0; j < tmpPackets.length; j++){
                if(typeof tmpPackets[j] === 'string') {
                    if((tmpStringPacket.length + (tmpPackets[j] as string).length) > this.limitBatchPackageLength) {
                        stringPackets.push(PacketType.Bundle +
                            ',[' + tmpStringPacket.substring(0, tmpStringPacket.length - 1) + ']');
                        tmpStringPacket = '';
                    }
                    tmpStringPacket += ('[' + tmpPackets[j] + '],');
                }
                else binaryPackets.push(tmpPackets[j]);
            }
        }
        if(tmpStringPacket.length)
            stringPackets.push(PacketType.Bundle +
                ',[' + tmpStringPacket.substring(0, tmpStringPacket.length - 1) + ']');

        return stringPackets.length ? [...stringPackets,...binaryPackets] : binaryPackets;
    }

    /**
     * Notice that the prepared package can not send multiple times.
     * If you need this you can check out the static method prepareMultiTransmit.
     * Also after preparing you should not send millions of other
     * packages before sending the prepared package.
     * It is perfect to prepare packages when the connection
     * is lost and send them when the socket is connected again.
     * @param receiver
     * @param data
     * @param processComplexTypes
     */
    prepareTransmit(receiver: string, data?: any, {processComplexTypes}: ComplexTypesOption = {}): PreparedPackage {
        if(!processComplexTypes) {
            return [PacketType.Transmit + ',"' + receiver + '",' +
            DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : '')];
        }
        else if(data instanceof WriteStream && Transport.streamsEnabled){
            const streamId = this._getNewStreamId(data.binary);
            const packet: PreparedPackage = [PacketType.Transmit + ',"' + receiver + '",' +
                DataType.Stream + ',' + streamId];
            data._init(this,streamId);
            packet._afterSend = () => data._onTransmitted();
            return packet;
        }
        else if(data instanceof ArrayBuffer) {
            const binaryId = this._getNewBinaryPlaceholderId();
            return [PacketType.Transmit + ',"' + receiver + '",' +
                DataType.Binary + ',' + binaryId, Transport._createBinaryReferencePacket(binaryId,data)];
        }
        else {
            const preparedPackage: PreparedPackage = [] as any;
            const streams: WriteStream<any>[] = [];
            preparedPackage.length = 1;
            data = this._processMixedJSONDeep(data,preparedPackage,streams);

            if(streams.length > 0)
                preparedPackage._afterSend = () => {for(let i = 0; i < streams.length; i++) streams[i]._onTransmitted();}

            preparedPackage[0] = PacketType.Transmit + ',"' + receiver + '",' +
                parseJSONDataType(preparedPackage.length > 1,streams.length > 0) +
                (data !== undefined ? (',' + encodeJson(data)) : '');
            return preparedPackage;
        }
    }

    /**
     * Notice that the prepared package can not send multiple times.
     * Also after preparing you should not send millions of other
     * packages before sending the prepared package.
     * It is perfect to prepare packages when the connection
     * is lost and send them when the socket is connected again.
     * @param procedure
     * @param data
     * @param ackTimeout
     * @param processComplexTypes
     * @param returnDataType
     */
    prepareInvoke<RDT extends true | false | undefined>(
        procedure: string,
        data?: any,
        {ackTimeout,processComplexTypes,returnDataType}: {ackTimeout?: number | null, returnDataType?: RDT} & ComplexTypesOption = {}
        ): PreparedInvokePackage<RDT extends true ? [any,DataType] : any>
    {
        const callId = this._getNewCid();
        const preparedPackage: PreparedInvokePackage = [] as any;

        if(!processComplexTypes) {
            preparedPackage.promise = new Promise<any>((resolve, reject) => {
                preparedPackage._afterSend = () => {
                    this._invokeResponsePromises[callId] = returnDataType ? {resolve, reject, returnDataType} : {resolve, reject};
                    this._invokeResponsePromises[callId].timeout = setTimeout(() => {
                        delete this._invokeResponsePromises[callId];
                        reject(new TimeoutError(`Response for call id: "${callId}" timed out`,TimeoutType.InvokeResponse));
                    }, ackTimeout || this.ackTimeout || Transport.ackTimeout);
                }
            });
            preparedPackage[0] = PacketType.Invoke + ',"' + procedure + '",' + callId + ',' +
                DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : '');
            return preparedPackage;
        }
        else {
            let setResponse: (() => void) | undefined = undefined;
            let setResponseTimeout: (() => void) | undefined = undefined;
            preparedPackage.promise = new Promise<any>((resolve, reject) => {
                setResponse = () => {
                    this._invokeResponsePromises[callId] = returnDataType ? {resolve, reject, returnDataType} : {resolve, reject};
                }
                setResponseTimeout = () => {
                    if(this._invokeResponsePromises[callId] && this._invokeResponsePromises[callId].timeout === undefined)
                        this._invokeResponsePromises[callId].timeout = setTimeout(() => {
                            delete this._invokeResponsePromises[callId];
                            reject(new TimeoutError(`Response for call id: "${callId}" timed out`,TimeoutType.InvokeResponse));
                        }, ackTimeout || this.ackTimeout || Transport.ackTimeout);
                }
            });

            if(data instanceof WriteStream && Transport.streamsEnabled){
                const sent = new Promise(res => preparedPackage._afterSend = () => {
                    setResponse!();
                    res();
                    (data as WriteStream<any>)._onTransmitted();
                });
                const streamId = this._getNewStreamId(data.binary);
                preparedPackage[0] = PacketType.Invoke + ',"' + procedure + '",' + callId + ',' +
                    DataType.Stream + ',' + streamId;
                Promise.all([sent,data.closed]).then(setResponseTimeout);
                data._init(this,streamId);
                return preparedPackage;
            }
            else if(data instanceof ArrayBuffer) {
                preparedPackage._afterSend = () => {
                    setResponse!();
                    setResponseTimeout!();
                }
                const binaryId = this._getNewBinaryPlaceholderId();
                preparedPackage[0] = PacketType.Invoke + ',"' + procedure + '",' + callId + ',' +
                    DataType.Binary + ',' + binaryId;
                preparedPackage[1] = Transport._createBinaryReferencePacket(binaryId,data);
                return preparedPackage;
            }
            else {
                preparedPackage.length = 1;
                const streams: WriteStream<any>[] = [];
                data = this._processMixedJSONDeep(data,preparedPackage,streams);
                if(streams.length > 0) {
                    const sent = new Promise(res => preparedPackage._afterSend = () => {
                        setResponse!();
                        res();
                        for(let i = 0; i < streams.length; i++) streams[i]._onTransmitted();
                    });
                    Promise.all([sent,...streams.map(stream => stream.closed)]).then(setResponseTimeout);
                }
                else preparedPackage._afterSend = () => {
                    setResponse!();
                    setResponseTimeout!();
                }
                preparedPackage[0] = PacketType.Invoke + ',"' + procedure + '",' + callId + ',' +
                    parseJSONDataType(preparedPackage.length > 1,streams.length > 0) +
                    (data !== undefined ? (',' + encodeJson(data)) : '');
                return preparedPackage;
            }
        }
    }

    // noinspection JSUnusedGlobalSymbols
    sendPreparedPackage(preparedPackage: PreparedPackage, batch?: number | true | null): void {
        if(!this._open) this._buffer.push(preparedPackage);
        else if(batch) this._addBatchPackage(preparedPackage,batch);
        else this._directSendPreparedPackage(preparedPackage);
    }

    // noinspection JSUnusedGlobalSymbols
    sendPreparedPackageWithPromise(preparedPackage: PreparedPackage, batch?: number | true | null): Promise<void> {
        if(batch) {
            return new Promise((resolve) => {
                const tmpAfterSend = preparedPackage._afterSend;
                preparedPackage._afterSend = () => {
                    if(tmpAfterSend) tmpAfterSend();
                    resolve();
                }
                this._addBatchPackage(preparedPackage,batch);
            })
        }
        else if(this._open) return this._directSendPreparedPackage(preparedPackage), RESOLVED_PROMISE;
        else return new Promise((resolve) => {
            const tmpAfterSend = preparedPackage._afterSend;
            preparedPackage._afterSend = () => {
                if(tmpAfterSend) tmpAfterSend();
                resolve();
            }
            this._buffer.push(preparedPackage);
        })
    }

    // noinspection JSUnusedGlobalSymbols
    invoke<RDT extends true | false | undefined>(procedure: string, data?: any, options:
        {ackTimeout?: number, batch?: number | true | null,returnDataType?: RDT} & ComplexTypesOption = {}):
        Promise<RDT extends true ? [any,DataType] : any>
    {
        const prePackage = this.prepareInvoke(procedure,data,options);
        this.sendPreparedPackage(prePackage,options.batch);
        return prePackage.promise;
    }

    // noinspection JSUnusedGlobalSymbols
    transmit(receiver: string, data?: any, options: {batch?: number | true | null} & ComplexTypesOption = {}) {
        this.sendPreparedPackage(this.prepareTransmit(receiver,data,options),options.batch);
    }

    // noinspection JSUnusedGlobalSymbols
    sendPing() {
        try {this.send(PING_BINARY);}
        catch (_) {}
    }

    // noinspection JSUnusedGlobalSymbols
    sendPong() {
        try {this.send(PONG_BINARY);}
        catch (_) {}
    }

    private _directSendPreparedPackage(preparedPackage: PreparedPackage) {
        if(preparedPackage.length === 1) this.send(preparedPackage[0])
        else for(let i = 0, len = preparedPackage.length; i < len; i++) this.send(preparedPackage[i]);
        if(preparedPackage._afterSend) preparedPackage._afterSend();
    }

    /**
     * @description
     * Removes a package from the batch list if it is not already sent.
     * The returned boolean indicates if it was successfully cancelled.
     * @param preparedPackage
     */
    public tryCancelPackage(preparedPackage: PreparedPackage): boolean {
        const index = this._buffer.indexOf(preparedPackage);
        if(index !== -1) {
            this._buffer.splice(index,1);
            if(this._buffer.length === 0 && this._bufferTimeoutTicker) {
                clearTimeout(this._bufferTimeoutTicker);
                this._bufferTimeoutTicker = undefined;
            }
            return true;
        }
        return false;
    }

    private _addBatchPackage(preparedPackage: PreparedPackage, batch: number | true) {
        this._buffer.push(preparedPackage);
        if(typeof batch !== 'number') return;
        if(this._bufferTimeoutTicker) {
            if(((this._bufferTimeoutDelay! - Date.now()) + this._bufferTimeoutTimestamp!) > batch){
                clearTimeout(this._bufferTimeoutTicker);
                this._setBufferTimeout(batch);
            }
        }
        else this._setBufferTimeout(batch);
    }

    // noinspection JSUnusedGlobalSymbols
    public flushBuffer(): boolean {
        this._clearBufferTimeout();
        return this._flushBuffer();
    }

    // noinspection JSUnusedGlobalSymbols
    public getBufferSize(): number {
        return this._buffer.length;
    }

    // noinspection JSUnusedGlobalSymbols
    public clearBuffer() {
        this._buffer = [];
    }

    private _onBatchTimeout = () => {
        this._bufferTimeoutTicker = undefined;
        this._flushBuffer();
    }

    private _flushBuffer(): boolean {
        if(!this._open) return false;
        const packages = this._buffer;
        this._buffer = [];
        if(packages.length <= (this.maxBufferChunkLength || Transport.maxBufferChunkLength))
            this._sendBufferChunk(packages);
        else {
            const chunkLength = (this.maxBufferChunkLength || Transport.maxBufferChunkLength);
            for (let i = 0,len = packages.length; i < len; i += chunkLength)
                this._sendBufferChunk(packages.slice(i, i + chunkLength))
        }
        return true;
    }

    private _sendBufferChunk(packages: PreparedPackage[]) {
        const compressPackage = this.compressPreparedPackages(packages), listLength = packages.length;
        for(let i = 0; i < compressPackage.length; i++) this.send(compressPackage[i]);
        for(let i = 0; i < listLength; i++) if(packages[i]._afterSend) packages[i]._afterSend!();
    }

    private _clearBufferTimeout() {
        if(this._bufferTimeoutTicker) {
            clearTimeout(this._bufferTimeoutTicker);
            this._bufferTimeoutTicker = undefined;
        }
    }

    private _setBufferTimeout(ms: number) {
        this._bufferTimeoutTicker = setTimeout(this._onBatchTimeout,ms);
        this._bufferTimeoutTimestamp = Date.now();
        this._bufferTimeoutDelay = ms;
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
            this.send((end ? PacketType.StreamEnd : PacketType.StreamChunk) +
                ',' + streamId + ',' + DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : ''));
        }
        else if(Transport.chunksCanContainStreams && data instanceof WriteStream){
            const streamId = this._getNewStreamId(data.binary);
            this.send((end ? PacketType.StreamEnd : PacketType.StreamChunk) +
                ',' + streamId + ',' + DataType.Stream + ',' + streamId);
            data._init(this,streamId);
            data._onTransmitted();
        }
        else if(data instanceof ArrayBuffer) this.send(
            Transport._createBinaryStreamChunkPacket(streamId,new Uint8Array(data),end));
        else {
            const packets: (string | ArrayBuffer)[] = [];
            const streams: WriteStream<any>[] = [];
            packets.length = 1;
            data = this._processMixedJSONDeep(data,packets,streams);

            packets[0] = (end ? PacketType.StreamEnd : PacketType.StreamChunk) +
                ',' + streamId + ',' + parseJSONDataType(packets.length > 1 || streams.length > 0) +
                (data !== undefined ? (',' + encodeJson(data)) : '');
            for(let i = 0; i < packets.length; i++) this.send(packets[i])
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
        this.send(Transport._createBinaryStreamChunkPacket(streamId,binaryPart,end))
    }

    /**
     * @internal
     * @description
     * Sends a stream end without any data.
     * @param streamId
     */
    _sendStreamEnd(streamId: number) {
        this.send(PacketType.StreamEnd + ',' + streamId);
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
        this.send(PacketType.StreamAccept + ',' + streamId + ',' + allowedSize);
    }

    /**
     * Only use when the connection was not lost in-between time.
     * @internal
     * @param streamId
     * @param allowedSize
     * @private
     */
    _sendStreamAllowMore(streamId: number,allowedSize: number) {
        this.send(PacketType.StreamDataPermission + ',' + streamId + ',' + allowedSize);
    }

    /**
     * Only use when the connection was not lost in-between time.
     * @internal
     * @param streamId
     * @param errorCode
     * @private
     */
    _sendReadStreamClose(streamId: number, errorCode?: number) {
        this.send(PacketType.ReadStreamClose + ',' + streamId +
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
        this.send(PacketType.WriteStreamClose + ',' + streamId + ',' + errorCode);
    }

    /**
     * @description
     * Creates a prepared transmit package that can be sent to multiple transporters
     * but not multiple times to the same transport (except there is no binary data in the package).
     * This is extremely efficient when sending to a lot of transporters.
     * Notice that streams are not supported but binaries are supported.
     * After preparing you should not wait a long time to send the package to the targets.
     * @param receiver
     * @param data
     * @param processComplexTypes
     */
    public static prepareMultiTransmit(receiver: string, data?: any, {processComplexTypes}: ComplexTypesOption = {}): PreparedPackage {
        if(!processComplexTypes) {
            return [PacketType.Transmit + ',"' + receiver + '",' +
            DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : '')];
        }
        else if(data instanceof ArrayBuffer) {
            const binaryId = Transport._getNewBinaryMultiPlaceholderId();
            return [PacketType.Transmit + ',"' + receiver + '",' +
                DataType.Binary + ',' + binaryId, Transport._createBinaryReferencePacket(binaryId,data)];
        }
        else {
            const preparedPackage: PreparedPackage = [];
            preparedPackage.length = 1;
            data = Transport._processMultiMixedJSONDeep(data,preparedPackage);
            preparedPackage[0] = PacketType.Transmit + ',"' + receiver + '",' +
                parseJSONDataType(preparedPackage.length > 1,false) +
                (data !== undefined ? (',' + encodeJson(data)) : '');
            return preparedPackage;
        }
    }

    private static _processMultiMixedJSONDeep(data: any, binaryReferencePackets: any[]) {
        if(typeof data === 'object' && data){
            if(data instanceof ArrayBuffer){
                const placeholderId = Transport._getNewBinaryMultiPlaceholderId();
                binaryReferencePackets.push(Transport._createBinaryReferencePacket(placeholderId, data));
                return {__binary__: placeholderId};
            }
            else if(Array.isArray(data)) {
                const newArray: any[] = [];
                const len = data.length;
                for (let i = 0; i < len; i++) {
                    newArray[i] = Transport._processMultiMixedJSONDeep(data[i], binaryReferencePackets);
                }
                return newArray;
            }
            else if(!(data instanceof Date)) {
                const clone = {};
                for(const key in data) {
                    // noinspection JSUnfilteredForInLoop
                    clone[key] = Transport._processMultiMixedJSONDeep(data[key], binaryReferencePackets);
                }
                return clone;
            }
        }
        return data;
    }
}