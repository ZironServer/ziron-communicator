/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

/**
 * A prepared package contains prepared or multiple packets.
 * The first packet is always the string header packet,
 * followed by optional binary packets.
 */
export type PreparedPackage = [string,ArrayBuffer?] & {
    /**
     * @description
     * Used to set the ack timeout.
     * Do not override or use this property.
     * @internal
     */
    _afterSend?: () => void;
    /**
     * @description
     * The size of the package (used internally).
     * Do not override or use this property.
     * @internal
     */
    _size?: number;
};

export type PreparedInvokePackage<T = any> = PreparedPackage & {
    promise: Promise<T>
}