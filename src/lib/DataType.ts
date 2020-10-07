/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import ReadStream from "./ReadStream";
import WriteStream from "./WriteStream";

export const enum DataType {
    JSON,
    Binary,
    Stream,
    JSONWithStreams,
    JSONWithBinaries,
    JSONWithStreamsAndBinary
}

export const DataTypeSymbol = Symbol();

ArrayBuffer[DataTypeSymbol] = DataType.Binary;
WriteStream[DataTypeSymbol] = DataType.Stream;
ReadStream[DataTypeSymbol] = DataType.Stream;

export function isMixedJSONDataType(type: DataType) {
    return type > 2;
}

export function parseJSONDataType(containsBinary?: boolean, containsStreams?: boolean): DataType {
    if(containsBinary)
        return containsStreams ? DataType.JSONWithStreamsAndBinary : DataType.JSONWithBinaries;
    else return containsStreams ? DataType.JSONWithStreams : DataType.JSON;
}

export function typeofData(data: any): DataType {
    if(typeof data === 'object' && data){
        if(typeof data[DataTypeSymbol] === 'number') return data[DataTypeSymbol];
        else {
            //analyse data...
            if(data instanceof ArrayBuffer) return DataType.Binary;
            else if(data instanceof ReadStream || data instanceof WriteStream) return DataType.Stream;
            else {
                const meta: {binaries?: boolean, streams?: boolean} = {};
                _analyseDataDeep(data,meta);
                return parseJSONDataType(meta.binaries,meta.streams);
            }

        }
    }
    else return DataType.JSON;
}

function _analyseDataDeep(data: any, meta: {binaries?: boolean, streams?: boolean}): void {
    if(meta.binaries && meta.streams) return;
    if(typeof data === 'object' && data){
        if(data instanceof ArrayBuffer) meta.binaries = true;
        else if(data instanceof ReadStream || data instanceof WriteStream) meta.streams = true;
        else if(Array.isArray(data)) {
            const len = data.length;
            for (let i = 0; i < len; i++) _analyseDataDeep(data,meta);
        }
        else for(const key in data) _analyseDataDeep(data,meta);
    }
}