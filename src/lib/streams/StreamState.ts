/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

export const enum StreamState {
    /**
     * @description
     * The stream is not used.
     * This state is used when a new WriteStream is created but not sent.
     */
    Unused,
    /**
     * @description
     * The stream is pending.
     * This state indicates a stream that is waiting to be accepted.
     */
    Pending,
    /**
     * @description
     * The stream is open.
     * The stream is connected to the Read- or Write-Stream and
     * can receive packages or sent packages to the other side.
     */
    Open,
    /**
     * @description
     * The stream is closed.
     * The stream is disconnected from the other stream and can not
     * receive packages or send packages to the other side.
     * When the stream has an error code, the stream is closed in an error state.
     */
    Closed
}