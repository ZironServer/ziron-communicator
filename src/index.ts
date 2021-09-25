/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import {JSONString} from "./lib/JsonUtils";
import WriteStream from "./lib/streams/WriteStream";
import Transport, {
    TransmitListener,
    InvokeListener,
    PreparedPackage,
    ComplexTypesOption
} from "./lib/Transport";
import ReadStream, {ChunkMiddleware} from "./lib/streams/ReadStream";
import {StreamErrorCloseCode} from "./lib/streams/StreamErrorCloseCode";
import {StreamState} from "./lib/streams/StreamState";
import {DataType, analyseTypeofData, containsStreams, containsBinaries, isMixedJSONDataType} from "./lib/DataType";
import {
    TimeoutError,
    TimeoutType,
    InvalidActionError,
    BadConnectionError,
    BadConnectionType,
    BackError
} from "./lib/Errors";
import {dehydrateError, hydrateError} from "./lib/ErrorUtils";
import StreamCloseError from "./lib/streams/StreamCloseError";

export {
    Transport,
    JSONString,
    WriteStream,
    ReadStream,
    ChunkMiddleware,
    StreamCloseError,
    StreamErrorCloseCode,
    StreamState,
    TimeoutError,
    TimeoutType,
    InvalidActionError,
    BadConnectionError,
    BadConnectionType,
    analyseTypeofData,
    containsStreams,
    containsBinaries,
    isMixedJSONDataType,
    DataType,
    TransmitListener,
    InvokeListener,
    PreparedPackage,
    ComplexTypesOption,
    hydrateError,
    dehydrateError,
    BackError
}