/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

export type BatchOptionsValue = number | true | null | undefined;
export interface BatchOption {
    /**
     * @description
     * Specifies the batch option.
     * This option helps to batch multiple packages to save performance.
     * When using the batch option, the package will be pushed into the buffer.
     * When the buffer gets flushed, all packages from the buffer will be compressed sequence safe.
     * With a number, you can specify the maximum time a package should wait in the buffer.
     * Whenever the lowest time of all packages in the buffer is reached, the buffer gets flushed.
     * A true value will push the package in the buffer but without any time limit.
     * So the flushing depends on other packages or on manually flushing the buffer.
     * Undefined, null, or 0 will not batch the package when the socket is connected and sends it directly.
     */
    batch?: BatchOptionsValue
}

export interface ResponseTimeoutOption {
    /**
     * @description
     * Defines the timeout in milliseconds for
     * receiving the response of an invoke.
     */
    responseTimeout?: number | null
}

export interface ReturnDataTypeOption<RDT extends true | false | undefined> {
    /**
     * @description
     * Defines if the data and the data type
     * should be returned wrapped in an array.
     * @default false
     */
    returnDataType?: RDT
}

export interface ComplexTypesOption {
    /**
     * Complex types are streams or array buffer.
     * If you want to send such types you need to activate this option.
     * Otherwise, these types will be ignored because of performance reasons.
     */
    processComplexTypes?: boolean
}