/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import {JSONString} from "./lib/JsonUtils";
import WriteStream from "./lib/WriteStream";
import Communicator from "./lib/Communicator";
import ReadStream from "./lib/ReadStream";
import {StreamCloseCode} from "./lib/StreamCloseCode";
import {StreamState} from "./lib/StreamState";
import {TimeoutError,TimeoutType,InvalidActionError,ConnectionLostError} from "./lib/Errors";

export {
    Communicator,
    JSONString,
    WriteStream,
    ReadStream,
    StreamCloseCode,
    StreamState,
    TimeoutError,
    TimeoutType,
    InvalidActionError,
    ConnectionLostError
}