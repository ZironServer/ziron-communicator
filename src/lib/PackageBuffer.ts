/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

import {PacketType} from "./Protocol";
import {PreparedPackage} from "./PreparedPackage";
import {guessStringSize} from "./Utils";
import {InsufficientBufferSizeError} from "./Errors";

/**
 * Class for buffering packages and send them batched together.
 * Notice that the buffer should be flushed on a connection when
 * the underlying source can have an unconnected state.
 */
export default class PackageBuffer {

    constructor(
        public send: (msg: string | ArrayBuffer) => void,
        public isConnected: () => boolean = () => true
    ) {}

    private _buffer: PreparedPackage[] = [];
    private _bufferSize: number = 0;

    private _bufferTimeoutDelay: number | undefined;
    private _bufferTimeoutTicker: NodeJS.Timeout | undefined;
    private _bufferTimeoutTimestamp: number | undefined;

    public maxBufferSize: number = Number.POSITIVE_INFINITY;

    /**
     * Used to find out the UTF-8 byte size of a string to detect if the buffer space is enough.
     * Defaults to guessStringSize for performance reasons but can be
     * replaced with a function that determines the byte size specific.
     */
    public static stringSizeDeterminer: (str: string) => number = guessStringSize;
    public static maxBufferChunkLength: number = 200;
    public static limitBatchStringPacketLength: number = 310000;

    public maxBufferChunkLength: number = PackageBuffer.maxBufferChunkLength;
    public limitBatchStringPacketLength: number = PackageBuffer.limitBatchStringPacketLength;

    /**
     * @description
     * Returns the count of packages in the buffer.
     */
    public getBufferLength(): number {
        return this._buffer.length;
    }

    /**
     * @description
     * Returns the buffer size.
     */
    public getBufferSize(): number {
        return this._bufferSize;
    }

    /**
     * @description
     * Clears the buffer.
     */
    public clearBuffer() {
        this._buffer = [];
        this._bufferSize = 0;
        this._clearBufferTimeout();
    }

    private _onBatchTimeout = () => {
        this._bufferTimeoutTicker = undefined;
        if(this.isConnected()) this._internalFlushBuffer();
    }

    /**
     * Adds the size of a package as meta information.
     * @param pack
     * @private
     */
    private static _addPreparedPackageSize(pack: PreparedPackage) {
        pack._size = PackageBuffer.stringSizeDeterminer(pack[0]);
        for(let i = pack.length - 1; i > 0; i--)
            pack._size += (pack[i] as ArrayBuffer).byteLength;
    }

    /**
     * @description
     * Adds a new package to the buffer.
     * Optionally a batch parameter can be provided to specify
     * the maximum time a package should wait in the buffer.
     * Whenever the lowest time of all packages in the buffer is reached,
     * the buffer gets flushed.
     * When the parameter is not provided or has a true value,
     * flushing depends on other packages or manually flushing the buffer.
     * Notice when the underlying source is not connected,
     * the buffer will not be flushed and should be flushed on reconnection.
     * When the new package would exceed the buffer size,
     * the buffer will be flushed automatically.
     * When it is not possible to flush the buffer in such a state,
     * an InsufficientBufferSizeError will be thrown.
     * @param preparedPackage
     * @param batch
     */
    public add(preparedPackage: PreparedPackage, batch?: number | true) {
        PackageBuffer._addPreparedPackageSize(preparedPackage);
        if(this._bufferSize + preparedPackage._size! > this.maxBufferSize) {
            //would max out buffer..
            if(this.isConnected()) {
                //Flush with new package directly.
                this._pushToBuffer(preparedPackage);
                this._internalFlushBuffer();
            }
            else throw new InsufficientBufferSizeError("PreparedPackageBuffer");
        }
        else this._pushToBuffer(preparedPackage);
        if(typeof batch === "number") this._setBatchTime(batch);
    }

    /**
     * @description
     * Tries to remove a package from the buffer if it is not already sent.
     * The returned boolean indicates if it was successfully removed.
     * @param preparedPackage
     */
    public tryRemove(preparedPackage: PreparedPackage): boolean {
        const index = this._buffer.indexOf(preparedPackage);
        if(index !== -1) {
            this._buffer.splice(index,1);
            this._bufferSize -= preparedPackage._size!;
            if(this._buffer.length === 0 && this._bufferTimeoutTicker) {
                clearTimeout(this._bufferTimeoutTicker);
                this._bufferTimeoutTicker = undefined;
            }
            return true;
        }
        return false;
    }

    private _pushToBuffer(pack: PreparedPackage) {
        this._buffer.push(pack);
        this._bufferSize += pack._size!;
    }

    private _setBatchTime(time: number) {
        if(this._bufferTimeoutTicker) {
            if(((this._bufferTimeoutDelay! - Date.now()) + this._bufferTimeoutTimestamp!) > time){
                clearTimeout(this._bufferTimeoutTicker);
                this._setBufferTimeout(time);
            }
        }
        else this._setBufferTimeout(time);
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
     * Clears the current buffer batch time ticker.
     * It can be used on disconnection of the underlying source.
     */
    public clearBatchTime() {
        this._clearBufferTimeout();
    }

    /**
     * @description
     * Flushes the buffer when the underlying source is connected;
     * otherwise, it returns false.
     */
    public flushBuffer(): boolean {
        if(!this.isConnected()) return false;
        this._flushBuffer();
        return true;
    }

    private _flushBuffer() {
        this._clearBufferTimeout();
        this._internalFlushBuffer();
    }

    private _internalFlushBuffer() {
        if(this._buffer.length < 1) return;
        const packages = this._buffer;
        this._buffer = [];
        this._bufferSize = 0;
        if(packages.length <= this.maxBufferChunkLength) this._sendBufferChunk(packages);
        else {
            const chunkLength = this.maxBufferChunkLength;
            for (let i = 0,len = packages.length; i < len; i += chunkLength)
                this._sendBufferChunk(packages.slice(i, i + chunkLength))
        }
    }

    private _sendBufferChunk(packages: PreparedPackage[]) {
        const compressPackage = this._compressPreparedPackages(packages), listLength = packages.length;
        for(let i = 0; i < compressPackage.length; i++) this.send(compressPackage[i]);
        for(let i = 0; i < listLength; i++) if(packages[i]._afterSend) packages[i]._afterSend!();
    }

    // noinspection JSMethodCanBeStatic
    /**
     * @description
     * This compression will keep the order of packages.
     * @param preparedPackages
     * @private
     */
    private _compressPreparedPackages(preparedPackages: PreparedPackage[]): (string|ArrayBuffer)[] {
        if(preparedPackages.length < 1) return [];
        const compressedPackets: (string|ArrayBuffer)[] = [], len = preparedPackages.length;
        let tmpStringPacket: string = "",tmpPacketsBundle: (string|ArrayBuffer)[] = [],
            tmpPackets: PreparedPackage, bundleHasBinary: boolean = false;
        tmpPacketsBundle.length = 1;

        for(let i = 0; i < len; i++) {
            tmpPackets = preparedPackages[i];
            if((bundleHasBinary && tmpPackets.length === 1) ||
                (tmpStringPacket.length > 0 &&
                    (tmpStringPacket.length + tmpPackets[0].length) > this.limitBatchStringPacketLength))
            {
                tmpPacketsBundle[0] = PacketType.Bundle +
                    ',[' + tmpStringPacket.substring(0, tmpStringPacket.length - 1) + ']';
                compressedPackets.push(...tmpPacketsBundle);
                tmpPacketsBundle = [];
                tmpPacketsBundle.length = 1;
                tmpStringPacket = '';
                bundleHasBinary = false;
            }
            tmpStringPacket += ('[' + tmpPackets[0] + '],');
            tmpPacketsBundle.push(...tmpPackets.slice(1));
            bundleHasBinary = bundleHasBinary || tmpPackets.length > 1;
        }
        tmpPacketsBundle[0] = PacketType.Bundle +
            ',[' + tmpStringPacket.substring(0, tmpStringPacket.length - 1) + ']';
        compressedPackets.push(...tmpPacketsBundle);
        return compressedPackets;
    }
}