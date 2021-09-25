/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import ReadStream from "./streams/ReadStream";
import WriteStream from "./streams/WriteStream";

export const enum DataType {
    JSON,
    Binary,
    Stream,
    JSONWithStreams,
    JSONWithBinaries,
    JSONWithStreamsAndBinary
}

export function isMixedJSONDataType(type: DataType) {
    return type > 2 && type < 6;
}

export function containsStreams(type: DataType) {
    return type > 1 && type !== DataType.JSONWithBinaries;
}

export function containsBinaries(type: DataType) {
    return type === DataType.Binary || type > 3;
}

export function parseJSONDataType(containsBinary?: boolean, containsStreams?: boolean): DataType {
    if(containsBinary)
        return containsStreams ? DataType.JSONWithStreamsAndBinary : DataType.JSONWithBinaries;
    else return containsStreams ? DataType.JSONWithStreams : DataType.JSON;
}

export function analyseTypeofData(data: any): DataType {
    if(typeof data === 'object' && data){
        if(data instanceof ArrayBuffer) return DataType.Binary;
        else if(data instanceof ReadStream || data instanceof WriteStream) return DataType.Stream;
        else {
            const meta: {binaries?: boolean, streams?: boolean} = {};
            _analyseDataDeep(data,meta);
            return parseJSONDataType(meta.binaries,meta.streams);
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
            for (let i = 0; i < len; i++) _analyseDataDeep(data[i],meta);
        }
        else for(const key in data) _analyseDataDeep(data[key],meta);
    }
}