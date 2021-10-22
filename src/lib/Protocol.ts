/*
Author: Ing. Luca Gian Scaringella
GitHub: LucaCode
Copyright(c) Ing. Luca Gian Scaringella
 */

import {DataType} from "./DataType";

export const enum PacketType {
    Bundle,
    Transmit,
    Invoke,
    InvokeDataResp,
    InvokeErrResp,
    BinaryReference,
    StreamAccept,
    StreamChunk,
    StreamEnd,
    StreamDataPermission,
    WriteStreamClose,
    ReadStreamClose,
}

/**
 * Indexes:
 * 0: PacketType
 * 1: Receiver
 * 2: DataType
 * 3: Data
 */
export type TransmitPacket = [PacketType.Transmit,string,DataType,any];

/**
 * Indexes:
 * 0: PacketType
 * 1: Procedure
 * 2: CallId
 * 3: DataType
 * 4: Data
 */
export type InvokePacket = [PacketType.Invoke,string,number,DataType,any];

/**
 * Indexes:
 * 0: PacketType
 * 1: CallId
 * 2: DataType
 * 3: Data
 */
export type InvokeDataRespPacket = [PacketType.InvokeDataResp,number,DataType,any];

/**
 * Indexes:
 * 0: PacketType
 * 1: CallId
 * 2: Err
 */
export type InvokeErrRespPacket = [PacketType.InvokeErrResp,number,any];

/**
 * Indexes:
 * 0: PacketType
 * 1: StreamId
 * 2: Buffer size (size is also allowed)
 */
export type StreamAcceptPacket = [PacketType.StreamAccept,number,number];

/**
 * Indexes:
 * 0: PacketType
 * 1: StreamId
 * 2: DataType
 * 3: Data
 */
export type StreamChunkPacket = [PacketType.StreamChunk,number,DataType,any];

/**
 * Indexes:
 * 0: PacketType
 * 1: StreamId
 * 2?: DataType
 * 3?: Data
 */
export type StreamEndPacket = [PacketType.StreamEnd,number,DataType?,any?];

/**
 * Indexes:
 * 0: PacketType
 * 1: StreamId
 * 2: Allowed size
 */
export type StreamDataPermissionPacket = [PacketType.StreamDataPermission,number,number];

/**
 * Indexes:
 * 0: PacketType
 * 1: StreamId
 * 2: Error code
 */
export type WriteStreamClosePacket = [PacketType.WriteStreamClose,number,number];

/**
 * Indexes:
 * 0: PacketType
 * 1: StreamId
 * 2: Error code
 */
export type ReadStreamClosePacket = [PacketType.ReadStreamClose,number,number?];

export type ActionPacket = TransmitPacket | InvokePacket | InvokeErrRespPacket |
    InvokeDataRespPacket | StreamAcceptPacket | StreamDataPermissionPacket |
    StreamChunkPacket | StreamEndPacket |
    WriteStreamClosePacket | ReadStreamClosePacket ;
export type BundlePacket = [PacketType.Bundle,ActionPacket[]];