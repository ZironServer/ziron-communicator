/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import {DataType} from "./DataType";

export const enum PacketType {
    Bundle,
    Transmit,
    Invoke,
    InvokeDataResp,
    StreamAccept,
    StreamChunk,
    ReadStreamClose,
    WriteStreamClose,
    BinaryReference,
    InvokeErrResp
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
 * 2: Err
 */
export type InvokeErrRespPacket = [PacketType.InvokeErrResp,number,any];

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
 * 1: StreamId
 */
export type StreamAcceptPacket = [PacketType.StreamAccept,number];

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
 * 2: code
 * 3?: DataType
 * 4?: Data
 */
export type WriteStreamClosePacket = [PacketType.WriteStreamClose,number,number,DataType | undefined,any | undefined];

/**
 * Indexes:
 * 0: PacketType
 * 1: StreamId
 * 2: code
 */
export type ReadStreamClosePacket = [PacketType.ReadStreamClose,number,number];

export type ActionPacket = TransmitPacket | InvokePacket | InvokeErrRespPacket |
    InvokeDataRespPacket | StreamAcceptPacket | StreamChunkPacket |
    WriteStreamClosePacket | ReadStreamClosePacket ;
export type BundlePacket = [PacketType.Bundle,ActionPacket[]];