/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

import PackageBuffer, {PackageBufferOptions} from "./PackageBuffer";
import {PreparedPackage} from "./PreparedPackage";
import Transport, {ComplexTypesOption} from "./Transport";
import {loadDefaults, SendFunction} from "./Utils";

export interface GroupTransportOptions extends PackageBufferOptions {}

/**
 * @description
 * This util class helps to build a transport for multiple end sources.
 * Instead of using the transport prepareMultiTransmit method and sending the
 * package with each transporter, the batching is not individual for
 * each transport and shared for the group.
 * When the underlying source has a temporarily disconnected state,
 * the buffer should be flushed on a reconnection.
 */
export default class GroupTransport {

    public readonly buffer: PackageBuffer;

    /**
     * @param send
     * The send function should send the message to every socket of the group once.
     * @param isConnected
     * Should return a boolean that indicates if the underlying source is completely connected.
     * When the underlying source does not have a disconnected state,
     * the function can always return true.
     * @param options
     */
    constructor(
        public readonly send: SendFunction,
        public readonly isConnected: () => boolean = () => true,
        /**
         * Notice that the provided options will not be cloned to save memory and performance.
         */
        public options: GroupTransportOptions = {...GroupTransport.DEFAULT_OPTIONS}
    ) {
        this.buffer = new PackageBuffer(this.send,isConnected,options);
    }

    public static readonly DEFAULT_OPTIONS: Readonly<GroupTransportOptions> = PackageBuffer.DEFAULT_OPTIONS;

    public static buildOptions(options: Partial<GroupTransportOptions>): GroupTransportOptions {
        return loadDefaults(options,GroupTransport.DEFAULT_OPTIONS);
    }

    private _directSendMultiTransmit(preparedPackage: PreparedPackage) {
        this.send(preparedPackage[0]);
        if(preparedPackage.length > 1)
            this.send(preparedPackage[1]!,true);
        if(preparedPackage._afterSend) preparedPackage._afterSend();
    }

    /**
     * Sends a transmit.
     * Notice that internally the prepareMultiTransmit method is used.
     * This method does not support streams, but binaries are supported.
     * @param receiver
     * @param data
     * @param options
     */
    transmit(receiver: string, data?: any, options: {batch?: number | true | null} & ComplexTypesOption = {}) {
        const preparedPackage = Transport.prepareMultiTransmit(receiver,data,options);
        if(!this.isConnected()) this.buffer.add(preparedPackage);
        else if(options.batch) this.buffer.add(preparedPackage,options.batch);
        else this._directSendMultiTransmit(preparedPackage);
    }
}