/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

import {JSONString} from "./lib/JsonUtils";
import WriteStream from "./lib/streams/WriteStream";
import Transport, {
    TransmitListener,
    InvokeListener,
    ComplexTypesOption, TransportOptions
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
    BackError,
    InsufficientBufferSizeError, MaxSupportedArrayBufferSizeExceededError
} from "./lib/Errors";
import {dehydrateError, hydrateError} from "./lib/ErrorUtils";
import StreamCloseError from "./lib/streams/StreamCloseError";
import { Package } from "./lib/Package";
import PackageBuffer, {PackageBufferOptions} from "./lib/PackageBuffer";
import GroupTransport, {GroupTransportOptions} from "./lib/GroupTransport";
import {MAX_SUPPORTED_ARRAY_BUFFER_SIZE} from "./lib/Utils";

export {
    Transport,
    TransportOptions,
    GroupTransport,
    GroupTransportOptions,
    PackageBuffer,
    PackageBufferOptions,
    InsufficientBufferSizeError,
    MaxSupportedArrayBufferSizeExceededError,
    MAX_SUPPORTED_ARRAY_BUFFER_SIZE,
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
    Package,
    ComplexTypesOption,
    hydrateError,
    dehydrateError,
    BackError
}