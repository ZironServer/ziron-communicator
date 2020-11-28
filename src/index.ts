/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import {JSONString} from "./lib/JsonUtils";
import WriteStream from "./lib/WriteStream";
import Communicator, {TransmitListener,InvokeListener, PreparedPackage} from "./lib/Communicator";
import ReadStream from "./lib/ReadStream";
import {StreamCloseCode} from "./lib/StreamCloseCode";
import {StreamState} from "./lib/StreamState";
import { DataType, analyseTypeofData } from "./lib/DataType";
import {TimeoutError, TimeoutType, InvalidActionError, BadConnectionError, BadConnectionType} from "./lib/Errors";

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
    BadConnectionError,
    BadConnectionType,
    analyseTypeofData,
    DataType,
    TransmitListener,
    InvokeListener,
    PreparedPackage
}