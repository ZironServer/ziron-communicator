/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import {JSONString} from "./lib/JsonUtils";
import WriteStream from "./lib/WriteStream";
import Transport, {
    TransmitListener,
    InvokeListener,
    PreparedPackage,
    ComplexTypesOption
} from "./lib/Transport";
import ReadStream from "./lib/ReadStream";
import {StreamCloseCode} from "./lib/StreamCloseCode";
import {StreamState} from "./lib/StreamState";
import { DataType, analyseTypeofData } from "./lib/DataType";
import {
    TimeoutError,
    TimeoutType,
    InvalidActionError,
    BadConnectionError,
    BadConnectionType,
    BackError
} from "./lib/Errors";
import {dehydrateError, hydrateError} from "./lib/ErrorUtils";

export {
    Transport,
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
    PreparedPackage,
    ComplexTypesOption,
    hydrateError,
    dehydrateError,
    BackError
}