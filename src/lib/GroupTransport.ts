/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

import PackageBuffer from "./PackageBuffer";
import {PreparedPackage} from "./PreparedPackage";
import Transport, {ComplexTypesOption} from "./Transport";

/**
 * @description
 * This util class helps to build a transport for multiple end connections.
 * Instead of using the transport prepareMultiTransmit method and sending the
 * package with each transporter, the batching is not individual for
 * each transport and shared for the group.
 * Notice that the internal buffer should be flushed on a complete connection of the
 * underlying source when it can have an unconnected state.
 */
export default class GroupTransport {

    public readonly buffer: PackageBuffer;

    constructor(
        private readonly send: (msg: string | ArrayBuffer) => void,
        public isConnected: () => boolean = () => true
    ) {
        this.buffer = new PackageBuffer(this.send,isConnected);
    }

    private _directSendMultiTransmit(preparedPackage: PreparedPackage) {
        this.send(preparedPackage[0]);
        if(preparedPackage.length > 1)
            for(let i = 1, len = preparedPackage.length; i < len; i++)
                this.send(preparedPackage[i]);
        if(preparedPackage._afterSend) preparedPackage._afterSend();
    }

    transmit(receiver: string, data?: any, options: {batch?: number | true | null} & ComplexTypesOption = {}) {
        const preparedPackage = Transport.prepareMultiTransmit(receiver,data,options);
        if(!this.isConnected()) this.buffer.add(preparedPackage);
        else if(options.batch) this.buffer.add(preparedPackage,options.batch);
        else this._directSendMultiTransmit(preparedPackage);
    }
}