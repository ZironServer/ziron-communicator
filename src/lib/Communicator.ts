/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import {
    ActionPacket,
    BundlePacket,
    DataType,
    InvokeDataRespPacket,
    InvokePacket,
    PacketType,
    TransmitPacket
} from "./Protocol";
import {dehydrateError, hydrateError} from "./ErrorUtils";
import {decodeJson, encodeJson, JSONString} from "./JsonUtils";
import ReadStream from "./ReadStream";
import WriteStream from "./WriteStream";
import {StreamCloseCode} from "./StreamCloseCode";
import {TimeoutError,TimeoutType,InvalidActionError,ConnectionLostError} from "./Errors";
import MixedJSON from "./MixedJSON";

type TransmitListener = (event: any, data: any) => void | Promise<void>;
type InvokeListener = (event: any, data: any, end: (data?: any) => void, reject: (err?: any) => void) => void | Promise<void>

/**
 * A prepared package contains prepared or multiple packets.
 */
type PreparedPackage = (string | ArrayBuffer)[] & {
    /**
     * @description
     * Used to open write streams.
     * @internal
     */
    _afterSend?: () => void;
    /**
     * @description
     * Used to add callId on invokes.
     * @internal
     */
    _beforeSend?: () => void;
};

type PreparedInvokePackage = PreparedPackage & {
    promise: Promise<any>
}

const PING = 57;
const PING_BINARY = new Uint8Array([PING]);

export default class Communicator {

    public static binaryResolveTimeout: number = 10000;
    public static ackTimeout: number = 10000;
    public static packetBinaryResolverLimit: number = 40;
    public static streamsEnabled: boolean = true;
    public static allowStreamAsChunk: boolean = false;

    public onInvalidMessage: (err: Error) => void;
    public onPacketProcessError: (err: Error) => void;
    public onTransmit: TransmitListener;
    public onInvoke: InvokeListener;
    public onPing: () => void;
    public send: (msg: string | ArrayBuffer) => void;

    constructor(connector: {
        onInvalidMessage?: (err: Error) => void;
        onPacketProcessError?: (err: Error) => void;
        onTransmit?: TransmitListener;
        onInvoke?: InvokeListener;
        onPing?: () => void;
        send?: (msg: string | ArrayBuffer) => void;
    } = {}) {
        this.onInvalidMessage = connector.onInvalidMessage || (() => {});
        this.onPacketProcessError = connector.onPacketProcessError || (() => {});
        this.onTransmit = connector.onTransmit || (() => {});
        this.onInvoke = connector.onInvoke || (() => {});
        this.onPing = connector.onPing || (() => {});
        this.send = connector.send || (() => {});
    }

    /**
     * Can not be reset on connection lost
     * because prepared packets with old ids can exist.
     */
    private _binaryPlaceHolderId: number = 0;
    private _binaryResolver: Record<number,{resolve: (binary: ArrayBuffer) => void,reject: (err: any) => void,timeout: NodeJS.Timeout}> = {};

    /**
     * Can not be reset on connection lost
     * because prepared packets with old ids can exist.
     */
    private _streamId: number = 0;
    private _activeReadStreams: Record<string, ReadStream> = {};
    private _activeWriteStreams: Record<string, WriteStream> = {};

    /**
     * Can not be reset on connection lost
     * because prepared packets with old ids can exist.
     */
    private _cid: number = 0;
    private _invokeResponsePromises: Record<number,{resolve: (data: any) => void,reject: (err: any) => void,timeout?: NodeJS.Timeout}> = {};

    private _batchSendList: PreparedPackage[] = [];
    private _batchTimeoutDelay: number | undefined;
    private _batchTimeoutTicker: NodeJS.Timeout | undefined;
    private _batchTimeoutTimestamp: number | undefined;

    private _connectionLostOnceListener: (() => void)[] = [];

    onMessage(rawMsg: string | ArrayBuffer) {
        try {
            if(typeof rawMsg !== "string"){
                if(rawMsg.byteLength === 1 && (new Uint8Array(rawMsg))[0] === PING) {
                    try {this.onPing();}
                    catch (err) {this.onPacketProcessError(err)}
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

    onConnectionLost() {
        this._clearBinaryResolver();
        this._rejectInvokeRespPromises(new ConnectionLostError());
        this._connectionLostToStreams();
        this._activeReadStreams = {};
        this._activeWriteStreams = {};
        for(let i = 0; i < this._connectionLostOnceListener.length; i++) this._connectionLostOnceListener[i]();
        this._connectionLostOnceListener = [];
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

    private _getNewCid(): number {
        if(this._cid > Number.MAX_SAFE_INTEGER) this._cid = 0;
        return this._cid++;
    }

    private _getNewStreamId(): number {
        if(this._streamId > Number.MAX_SAFE_INTEGER) this._streamId = 0;
        return this._streamId++;
    }

    private _processBinaryPacket(buffer: ArrayBuffer) {
        const header = (new Uint8Array(buffer.slice(0,1)))[0];
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
            this._processBinaryStreamChunk((new Float64Array(buffer.slice(1,9)))[0],buffer.slice(9))
        else if(header === PacketType.WriteStreamClose)
            this._processBinaryStreamClose((new Float64Array(buffer.slice(1,9)))[0],
                (new Float64Array(buffer.slice(9,17)))[0],buffer.slice(17))
        else this.onInvalidMessage(new Error('Unknown binary package header type.'))
    }

    private async _processJsonActionPacket(packet: ActionPacket) {
        switch (packet['0']) {
            case PacketType.Transmit:
                return this.onTransmit(packet['1'],await this._processData(packet['2'],packet['3']));
            case PacketType.Invoke:
                if(typeof packet['2'] !== 'number') return this.onInvalidMessage(new Error('CallId is not a number.'));
                return this._processInvoke(this.onInvoke,packet['1'],packet['2'],
                    await this._processData(packet['3'],packet['4']))
            case PacketType.InvokeDataResp:
                const resp = this._invokeResponsePromises[packet['1']];
                if (resp) {
                    clearTimeout(resp.timeout!);
                    delete this._invokeResponsePromises[packet['1']];
                    return resp.resolve(await this._processData(packet['2'],packet['3']));
                }
                return;
            case PacketType.StreamChunk: return this._processJsonStreamChunk(packet['1'],packet['2'],packet['3']);
            case PacketType.WriteStreamClose: return this._processJsonWriteStreamClose(packet['1'], packet['2'], packet['3'], packet['4']);
            case PacketType.StreamAccept: return this._processStreamAccept(packet['1']);
            case PacketType.ReadStreamClose: return this._processReadStreamClose(packet['1'], packet['2']);
            case PacketType.InvokeErrResp: return this._rejectInvoke(packet['1'],packet['2']);
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

    private _processStreamAccept(streamId: number) {
        const stream = this._activeWriteStreams[streamId];
        if(stream) stream._open();
    }

    private _processReadStreamClose(streamId: number, code: StreamCloseCode | number) {
        const stream = this._activeWriteStreams[streamId];
        if(stream && typeof code === 'number') {
            stream.close(code);
        }
    }

    private _processJsonWriteStreamClose(streamId: number, code: StreamCloseCode | number, dataType?: DataType, data?: any) {
        const stream = this._activeReadStreams[streamId];
        if(stream) {
            if(typeof dataType === 'number' && (dataType !== DataType.Stream || Communicator.allowStreamAsChunk))
                stream._addChunkToChain(this._processData(dataType,data));
            if(typeof code === 'number') stream._addCloseToChain(code);
        }
    }

    private _processJsonStreamChunk(streamId: number, dataType: DataType, data: any) {
        const stream = this._activeReadStreams[streamId];
        if(stream && (dataType !== DataType.Stream || Communicator.allowStreamAsChunk))
            stream._addChunkToChain(this._processData(dataType,data));
    }

    private _processBinaryStreamChunk(streamId: number, binary: ArrayBuffer) {
        const stream = this._activeReadStreams[streamId];
        if(stream) stream._addChunkToChain(Promise.resolve(binary));
    }

    private _processBinaryStreamClose(streamId: number, code: StreamCloseCode | number, binary: ArrayBuffer) {
        const stream = this._activeReadStreams[streamId];
        if(stream) {
            if(binary.byteLength > 0) stream._addChunkToChain(Promise.resolve(binary));
            if(typeof code === 'number') stream._addCloseToChain(code);
        }
    }

    private _processInvoke(caller: InvokeListener, event: any, callId: number, data: any) {
        let called;
        caller(event, data,(data) => {
            if(called) throw new InvalidActionError('Response ' + callId + ' has already been sent');
            called = true;
            this._sendInvokeDataResp(callId, data);
        }, (err) => {
            if(called) throw new InvalidActionError('Response ' + callId + ' has already been sent');
            called = true;
            this.send(PacketType.InvokeErrResp + ',' +
                callId + ',' + (err instanceof JSONString ? JSONString.toString() : encodeJson(dehydrateError(err)))
            );
        });
    }

    private _sendInvokeDataResp(callId: number, data: any) {
        if(data instanceof WriteStream && Communicator.streamsEnabled){
            const streamId = this._getNewStreamId();
            this.send(PacketType.InvokeDataResp + ',' + callId + ',' +
                DataType.Stream + ',' + streamId);
            data._init(this,streamId);
        }
        else if(data instanceof ArrayBuffer) {
            const binaryId = this._getNewBinaryPlaceholderId();
            this.send(PacketType.InvokeDataResp + ',' + callId + ',' +
                DataType.Binary + ',' + binaryId);
            this.send(Communicator._createBinaryReferencePacket(binaryId,data));
        }
        else if(data instanceof MixedJSON){
            const packets: (string | ArrayBuffer)[] = [];
            const streams: any[] = [];
            packets.length = 1;
            data = this._processMixedJSONDeep(data.data,packets,streams);
            if(packets.length > 1 || streams.length > 0){
                packets[0] = PacketType.InvokeDataResp + ',' + callId + ',' +
                    DataType.MixedJSON + ',' + encodeJson(data);
                for(let i = 0; i < packets.length; i++) this.send(packets[i])
            }
            else {
                this.send(PacketType.InvokeDataResp + ',' + callId + ',' +
                    DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : ''));
            }
        }
        else {
            this.send(PacketType.InvokeDataResp + ',' + callId + ',' +
                DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : ''));
        }
    }

    private _processData(type: DataType, data: any): Promise<any> | any {
        if (type === DataType.JSON) return data;
        else if (type === DataType.Binary) {
            if(typeof data !== 'number') return this.onInvalidMessage(new Error('Invalid binary placeholder type.'));
            return this._createBinaryResolver(data);
        } else if (type === DataType.MixedJSON) {
            const promises: Promise<any>[] = [];
            const wrapper = [data];
            this._resolveMixedJSONDeep(wrapper, 0, promises);
            return new Promise(async resolve => {
                await Promise.all(promises);
                resolve(wrapper[0]);
            });
        } else if(type === DataType.Stream && Communicator.streamsEnabled) {
            if(typeof data !== 'number') return this.onInvalidMessage(new Error('StreamId is not a number.'));
            return new ReadStream(data,this);
        }
        else return this.onInvalidMessage(new Error('Invalid data type.'));
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
                }, Communicator.binaryResolveTimeout)
            };
        });
    }

    private _resolveMixedJSONDeep(obj: any, key: any, binaryResolverPromises: Promise<any>[]): any {
        const value = obj[key];
        if(typeof value === 'object' && value) {
            if(Array.isArray(value)) {
                const len = value.length;
                for (let i = 0; i < len; i++) this._resolveMixedJSONDeep(value, i, binaryResolverPromises);
            }
            else  {
                if(typeof value['__binary__'] === 'number'){
                    if(binaryResolverPromises.length >= Communicator.packetBinaryResolverLimit)
                        throw new Error('Max binary resolver limit reached.')
                    binaryResolverPromises.push(new Promise(async (resolve) => {
                        // noinspection JSUnfilteredForInLoop
                        obj[key] = await this._createBinaryResolver(value['__binary__']);
                        resolve();
                    }));
                }
                else if(typeof value['__stream__'] === 'number' && Communicator.streamsEnabled){
                    obj[key] = new ReadStream(value['__stream__'],this);
                }
                else for(const key in value) this._resolveMixedJSONDeep(value, key, binaryResolverPromises);
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

    private _processMixedJSONDeep(data: any, binaryReferencePackets: any[], streamClosed: Promise<void>[]) {
        if(typeof data === 'object' && data){
            if(data instanceof ArrayBuffer){
                const placeholderId = this._getNewBinaryPlaceholderId();
                binaryReferencePackets.push(Communicator._createBinaryReferencePacket(placeholderId, data));
                return {__binary__: placeholderId};
            }
            else if(data instanceof WriteStream && Communicator.streamsEnabled){
                const streamId = this._getNewStreamId();
                data._init(this,streamId);
                streamClosed.push(data.closed);
                return  {__stream__: streamId}
            }
            else if(Array.isArray(data)) {
                const newArray: any[] = [];
                const len = data.length;
                for (let i = 0; i < len; i++) {
                    newArray[i] = this._processMixedJSONDeep(data[i], binaryReferencePackets, streamClosed);
                }
                return newArray;
            }
            else if(!(data instanceof Date)) {
                const clone = {};
                for(const key in data) {
                    // noinspection JSUnfilteredForInLoop
                    clone[key] = this._processMixedJSONDeep(data[key], binaryReferencePackets, streamClosed);
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

    private _connectionLostToStreams() {
        for (const k in this._activeReadStreams) {
            if (this._activeReadStreams.hasOwnProperty(k))
                this._activeReadStreams[k]._connectionLost();
        }
        for (const k in this._activeWriteStreams) {
            if (this._activeWriteStreams.hasOwnProperty(k))
                this._activeWriteStreams[k]._connectionLost();
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
    _addWriteStream(id: number, stream: WriteStream) {
        this._activeWriteStreams[id] = stream;
    }

    /**
     * @internal
     * @param writeStream
     * @private
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
        const binaryPackets: PreparedPackage = [];
        let textPackets: string = '';

        const len = preparedPackets.length;
        let tmpPackets: PreparedPackage;
        for(let i = 0; i < len; i++) {
            tmpPackets = preparedPackets[i];
            for(let j = 0; j < tmpPackets.length; j++){
                if(typeof tmpPackets[j] === 'string')
                    textPackets += ('[' + tmpPackets[j] + '],');
                else binaryPackets.push(tmpPackets[j]);
            }
        }

        if(textPackets.length > 0) {
            return [PacketType.Bundle + ',[' + textPackets.substring(0, textPackets.length - 1) + ']'
                ,...binaryPackets];
        }
        return binaryPackets;
    }

    /**
     * Notice that prepared packages can not send multiple times.
     * Also after preparing you should not send millions of other
     * packages before sending the prepared package.
     * It is perfect to prepare packages when the connection
     * is lost and send them when the socket is connected again.
     * @param event
     * @param data
     */
    prepareTransmit(event: string, data?: any): PreparedPackage {
        if(data instanceof WriteStream && Communicator.streamsEnabled){
            const streamId = this._getNewStreamId();
            const packet: PreparedPackage = [PacketType.Transmit + ',"' + event + '",' +
                DataType.Stream + ',' + streamId];
            data._init(this,streamId);
            return packet;
        }
        else if(data instanceof ArrayBuffer) {
            const binaryId = this._getNewBinaryPlaceholderId();
            return [PacketType.Transmit + ',"' + event + '",' +
                DataType.Binary + ',' + binaryId, Communicator._createBinaryReferencePacket(binaryId,data)];
        }
        else if(data instanceof MixedJSON){
            const preparedPackage: PreparedPackage = [];
            const streams: any[] = [];
            preparedPackage.length = 1;
            data = this._processMixedJSONDeep(data.data,preparedPackage,streams);
            preparedPackage[0] = PacketType.Transmit + ',"' + event + '",' +
                    ((preparedPackage.length > 1 || streams.length > 0) ? DataType.MixedJSON : DataType.JSON) +
                    (data !== undefined ? (',' + encodeJson(data)) : '');
            return preparedPackage;
        }
        else {
            return [PacketType.Transmit + ',"' + event + '",' +
            DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : '')];
        }
    }

    /**
     * Notice that prepared packages can not send multiple times.
     * Also after preparing you should not send millions of other
     * packages before sending the prepared package.
     * It is perfect to prepare packages when the connection
     * is lost and send them when the socket is connected again.
     * @param event
     * @param data
     * @param ackTimeout
     */
    prepareInvoke(event: string, data?: any, ackTimeout?: number | null): PreparedInvokePackage {
        const callId = this._getNewCid();
        const preparedPackage: PreparedInvokePackage = [] as any;

        let setResponseTimeout: (() => void) | undefined = undefined;

        preparedPackage.promise = new Promise<any>((resolve, reject) => {
            this._invokeResponsePromises[callId] = {resolve, reject};
            setResponseTimeout = () => {
                if(this._invokeResponsePromises[callId] && this._invokeResponsePromises[callId].timeout === undefined)
                    this._invokeResponsePromises[callId].timeout = setTimeout(() => {
                        delete this._invokeResponsePromises[callId];
                        reject(new TimeoutError(`Response for call id: "${callId}" timed out`,TimeoutType.InvokeResponse));
                    }, ackTimeout || Communicator.ackTimeout);
            }
        });

        if(data instanceof WriteStream && Communicator.streamsEnabled){
            const streamId = this._getNewStreamId();
            preparedPackage[0] = PacketType.Invoke + ',"' + event + '",' + callId + ',' +
                DataType.Stream + ',' + streamId;
            data.closed.then(setResponseTimeout);
            data._init(this,streamId);
            return preparedPackage;
        }
        else if(data instanceof ArrayBuffer) {
            preparedPackage._beforeSend = setResponseTimeout;
            const binaryId = this._getNewBinaryPlaceholderId();
            preparedPackage[0] = PacketType.Invoke + ',"' + event + '",' + callId + ',' +
                DataType.Binary + ',' + binaryId;
            preparedPackage[1] = Communicator._createBinaryReferencePacket(binaryId,data);
            return preparedPackage;
        }
        else if(data instanceof MixedJSON){
            preparedPackage.length = 1;
            const streams = [];
            data = this._processMixedJSONDeep(data.data,preparedPackage,streams);
            if(streams.length > 0) Promise.all(streams).then(setResponseTimeout)
            else preparedPackage._beforeSend = setResponseTimeout;
            preparedPackage[0] = PacketType.Invoke + ',"' + event + '",' + callId + ',' +
                ((preparedPackage.length > 1 || streams.length > 0) ? DataType.MixedJSON : DataType.JSON) +
                (data !== undefined ? (',' + encodeJson(data)) : '');
            return preparedPackage;
        }
        else {
            preparedPackage._beforeSend = setResponseTimeout;
            preparedPackage[0] = PacketType.Invoke + ',"' + event + '",' + callId + ',' +
                DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : '');
            return preparedPackage;
        }
    }

    // noinspection JSUnusedGlobalSymbols
    sendPreparedPackage(preparedPackage: PreparedPackage, batchTimeLimit?: number): void {
        if(batchTimeLimit) this._addToBatchList(preparedPackage,batchTimeLimit)
        else this._sendPreparedPackage(preparedPackage);
    }

    // noinspection JSUnusedGlobalSymbols
    async sendPreparedPackageWithPromise(preparedPackage: PreparedPackage, batchTimeLimit?: number): Promise<void> {
        if(batchTimeLimit) {
            return new Promise((resolve, reject) => {
                const connectionLostListener = () => reject(new Error('Connection lost.'));
                this._connectionLostOnceListener.push(connectionLostListener);
                const tmpAfterSend = preparedPackage._afterSend;
                preparedPackage._afterSend = () => {
                    const listenerIndex = this._connectionLostOnceListener.indexOf(connectionLostListener);
                    if(listenerIndex !== -1) this._connectionLostOnceListener.splice(listenerIndex, 1);
                    if(tmpAfterSend) tmpAfterSend();
                    resolve();
                }
                this._addToBatchList(preparedPackage,batchTimeLimit);
            })
        }
        else this._sendPreparedPackage(preparedPackage);
    }

    // noinspection JSUnusedGlobalSymbols
    invoke(event: string, data?: any, options:
        {ackTimeout?: number | null, batchTimeLimit?: number} = {}): Promise<any> {
        const prePackage = this.prepareInvoke(event,data,options.ackTimeout);
        this.sendPreparedPackage(prePackage,options.batchTimeLimit);
        return prePackage.promise;
    }

    // noinspection JSUnusedGlobalSymbols
    transmit(event: string, data?: any, options: {batchTimeLimit?: number} = {}) {
        this.sendPreparedPackage(this.prepareTransmit(event,data),options.batchTimeLimit);
    }

    // noinspection JSUnusedGlobalSymbols
    sendPing() {
        this.send(PING_BINARY);
    }

    private _sendPreparedPackage(preparedPackage: PreparedPackage) {
        if(preparedPackage._beforeSend) preparedPackage._beforeSend();
        if(preparedPackage.length === 1) this.send(preparedPackage[0])
        else for(let i = 0; i < preparedPackage.length; i++) this.send(preparedPackage[i]);
        if(preparedPackage._afterSend) preparedPackage._afterSend();
    }

    private _addToBatchList(preparedPackage: PreparedPackage, batchTimeLimit: number) {
        this._batchSendList.push(preparedPackage);
        if(this._batchTimeoutTicker) {
            if((this._batchTimeoutDelay! - Date.now() + this._batchTimeoutTimestamp!) > batchTimeLimit){
                clearTimeout(this._batchTimeoutTicker);
                this._setBatchTimeout(batchTimeLimit);
            }
        }
        else this._setBatchTimeout(batchTimeLimit);
    }

    private _onBatchTimeout = () => {
        this._batchTimeoutTicker = undefined;
        this._flushBatch();
    }

    private _flushBatch() {
        const batchPackages = this._batchSendList;
        this._batchSendList = [];
        const compressPackage = this.compressPreparedPackages(batchPackages);
        const listLength = batchPackages.length;
        try {
            let tmpPreparedPackages: PreparedPackage;
            for(let i = 0; i < listLength; i++) {
                tmpPreparedPackages = batchPackages[i];
                if(tmpPreparedPackages._beforeSend) tmpPreparedPackages._beforeSend();
            }
            for(let i = 0; i < compressPackage.length; i++){this.send(compressPackage[i]);}
            for(let i = 0; i < listLength; i++) {
                tmpPreparedPackages = batchPackages[i];
                if(tmpPreparedPackages._afterSend) tmpPreparedPackages._afterSend();
            }
        }
        catch (err) {}
    }

    private _setBatchTimeout(ms: number) {
        this._batchTimeoutTicker = setTimeout(this._onBatchTimeout,ms);
        this._batchTimeoutTimestamp = Date.now();
        this._batchTimeoutDelay = ms;
    }

    /**
     * @internal
     * @param streamId
     * @param data
     * @private
     */
    _sendStreamChunk(streamId: number, data: any) {
        if(Communicator.allowStreamAsChunk && data instanceof WriteStream){
            const streamId = this._getNewStreamId();
            this.send(PacketType.StreamChunk + ',' + streamId + ',' +
                DataType.Stream + ',' + streamId);
            data._init(this,streamId);
        }
        else if(data instanceof ArrayBuffer) this.send(Communicator._createBinaryStreamChunkPacket(streamId,data));
        else if(data instanceof MixedJSON){
            const packets: (string | ArrayBuffer)[] = [];
            const streams: any[] = [];
            packets.length = 1;
            data = this._processMixedJSONDeep(data.data,packets,streams);
            if(packets.length > 1 || streams.length > 0){
                packets[0] = PacketType.StreamChunk + ',' + streamId + ',' +
                    DataType.MixedJSON + ',' + encodeJson(data);
                for(let i = 0; i < packets.length; i++) this.send(packets[i])
            }
            else {
                this.send(PacketType.StreamChunk + ',' + streamId + ',' +
                    DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : ''));
            }
        }
        else {
            this.send(PacketType.StreamChunk + ',' + streamId + ',' +
                DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : ''));
        }
    }

    private static _createBinaryStreamChunkPacket(streamId: number, binary: ArrayBuffer): ArrayBuffer {
        const packetBuffer = new Uint8Array(9 + binary.byteLength);
        packetBuffer[0] = PacketType.StreamChunk;
        packetBuffer.set(new Uint8Array((new Float64Array([streamId])).buffer),1);
        packetBuffer.set(new Uint8Array(binary),9);
        return packetBuffer.buffer;
    }

    /**
     * @internal
     * @param streamId
     * @private
     */
    _sendStreamAccept(streamId: number) {
        this.send(PacketType.StreamAccept + ',' + streamId);
    }

    /**
     * @internal
     * @param streamId
     * @param code
     * @private
     */
    _sendReadStreamClose(streamId: number, code: number) {
        this.send(PacketType.ReadStreamClose + ',' + streamId + ',' + code);
    }

    /**
     * @internal
     * @param streamId
     * @param data
     * @param complexData
     * @private
     */
    _sendWriteStreamClose(streamId: number, code: number, data?: any) {
        if(data === undefined) return this.send(PacketType.WriteStreamClose + ',' + streamId + ',' + code);
        else {
            if(Communicator.allowStreamAsChunk && data instanceof WriteStream){
                const streamId = this._getNewStreamId();
                this.send(PacketType.WriteStreamClose + ',' + streamId + ',' + code + ',' +
                    DataType.Stream + ',' + streamId);
                data._init(this,streamId);
            }
            else if(data instanceof ArrayBuffer) this.send(Communicator._createBinaryWriteStreamClosePacket(streamId, code, data));
            else if(data instanceof MixedJSON){
                const packets: (string | ArrayBuffer)[] = [];
                const streams: any[] = [];
                packets.length = 1;
                data = this._processMixedJSONDeep(data.data,packets,streams);
                if(packets.length > 1 || streams.length > 0){
                    packets[0] = PacketType.WriteStreamClose + ',' + streamId + ',' + code + ',' +
                        DataType.MixedJSON + ',' + encodeJson(data);
                    for(let i = 0; i < packets.length; i++) this.send(packets[i])
                }
                else {
                    this.send(PacketType.WriteStreamClose + ',' + streamId + ',' + code + ',' +
                        DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : ''));
                }
            }
            else {
                this.send(PacketType.WriteStreamClose + ',' + streamId + ',' + code + ',' +
                    DataType.JSON + (data !== undefined ? (',' + encodeJson(data)) : ''));
            }
        }
    }

    private static _createBinaryWriteStreamClosePacket(streamId: number, code: number, binary: ArrayBuffer): ArrayBuffer {
        const packetBuffer = new Uint8Array(17 + binary.byteLength);
        packetBuffer[0] = PacketType.WriteStreamClose;
        packetBuffer.set(new Uint8Array((new Float64Array([streamId])).buffer),1);
        packetBuffer.set(new Uint8Array((new Float64Array([code])).buffer),9)
        packetBuffer.set(new Uint8Array(binary),17);
        return packetBuffer.buffer;
    }
}