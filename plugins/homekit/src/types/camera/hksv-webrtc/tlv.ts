// Minimal TLV8 helpers for the HKSV 2026 characteristics.
// HAP TLV8: 1 byte type, 1 byte length, up to 255 bytes of value. Values longer than 255 bytes
// are split across consecutive entries of the same type. Repeated entries (lists) are separated
// by an empty entry of type 0x00.

import { decodeWithLists } from '@homebridge/hap-nodejs/dist/lib/util/tlv';

export type TlvItems = Record<number, Buffer | Buffer[]>;

export function tlv(type: number, value: Buffer | number | string | boolean): Buffer {
    let data: Buffer;
    if (Buffer.isBuffer(value))
        data = value;
    else if (typeof value === 'string')
        data = Buffer.from(value, 'utf8');
    else if (typeof value === 'boolean')
        data = Buffer.from([value ? 1 : 0]);
    else
        data = Buffer.from([value]);

    if (!data.length)
        return Buffer.from([type, 0]);

    const chunks: Buffer[] = [];
    for (let offset = 0; offset < data.length; offset += 255) {
        const chunk = data.subarray(offset, Math.min(offset + 255, data.length));
        chunks.push(Buffer.from([type, chunk.length]), chunk);
    }
    return Buffer.concat(chunks);
}

export function tlvList(type: number, values: Buffer[]): Buffer {
    const parts: Buffer[] = [];
    values.forEach((value, index) => {
        if (index)
            parts.push(Buffer.from([0, 0]));
        parts.push(tlv(type, value));
    });
    return Buffer.concat(parts);
}

export function uint8(value: number) {
    return Buffer.from([value & 0xff]);
}

export function uint16(value: number) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(value);
    return b;
}

export function uint32(value: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0);
    return b;
}

export function uint64(value: number | bigint) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(value));
    return b;
}

export function decode(buffer: Buffer): TlvItems {
    return decodeWithLists(buffer);
}

export function single(items: TlvItems, type: number): Buffer | undefined {
    const value = items[type];
    if (!value)
        return undefined;
    if (Array.isArray(value))
        return value[0];
    return value;
}

export function list(items: TlvItems, type: number): Buffer[] {
    const value = items[type];
    if (!value)
        return [];
    if (Array.isArray(value))
        return value;
    return [value];
}

export function readUInt16(buffer: Buffer | undefined) {
    if (!buffer?.length)
        return undefined;
    return buffer.readUInt16LE(0);
}

export function readUInt32(buffer: Buffer | undefined) {
    if (!buffer?.length)
        return undefined;
    return buffer.readUInt32LE(0);
}

// HAP TLV8 characteristic values travel as base64 strings.
export function toValue(buffer: Buffer) {
    return buffer.toString('base64');
}

export function fromValue(value: unknown): Buffer {
    if (Buffer.isBuffer(value))
        return value;
    if (typeof value !== 'string')
        return Buffer.alloc(0);
    return Buffer.from(value, 'base64');
}
