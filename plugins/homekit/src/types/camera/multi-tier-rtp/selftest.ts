import { decodeWithLists } from '@homebridge/hap-nodejs/dist/lib/util/tlv';
import { Accessory, Characteristic, uuid } from '../../../hap';
import { addMultiTierRtpService } from './index';

function tlv(type: number, data: Buffer) { return Buffer.concat([Buffer.from([type, data.length]), data]); }
const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

async function main() {
    const accessory = new Accessory('mtr', uuid.generate('mtr-test'));
    const tiers = [
        { id: 1, quality: 2, width: 3840, height: 2160, fps: 30, averageKbps: 4500, peakKbps: 5000 },
        { id: 2, quality: 3, width: 1920, height: 1080, fps: 30, averageKbps: 1700, peakKbps: 1800 },
        { id: 3, quality: 4, width: 640, height: 360, fps: 15, averageKbps: 180, peakKbps: 190 },
    ];
    const device: any = { getVideoStream: async () => { throw new Error('not needed'); } };
    const { service } = await addMultiTierRtpService(accessory, device, console as any, tiers, Buffer.alloc(16, 7));

    console.log('service', service.UUID.slice(0, 8), service.characteristics.map(c => `${c.UUID.slice(4, 8)}:${c.props.format}:${c.props.perms.join('')}`).join(' '));

    // tiers decode
    const tiersChar = service.characteristics.find(c => c.UUID.startsWith('00008043'));
    const decoded = decodeWithLists(Buffer.from(tiersChar.value as string, 'base64'));
    const list = Array.isArray(decoded[3]) ? decoded[3] as Buffer[] : [decoded[3] as Buffer];
    console.log('codec', (decoded[1] as Buffer)[0], 'pt', (decoded[2] as Buffer)[0], 'tiers', list.length);
    if ((decoded[1] as Buffer)[0] !== 2) throw new Error('codec must be H265 (2)');
    if (list.length !== 3) throw new Error('expected 3 tiers');
    const t0 = decodeWithLists(list[0]);
    console.log('tier1', (t0[4] as Buffer).readUInt16LE(0), 'x', (t0[5] as Buffer).readUInt16LE(0));
    if ((t0[4] as Buffer).readUInt16LE(0) !== 3840) throw new Error('tier width mismatch');

    // Setup Endpoints round trip with a realistic controller write.
    const sessionId = Buffer.alloc(16, 3);
    const write = Buffer.concat([
        tlv(1, sessionId),
        tlv(3, Buffer.concat([tlv(1, u8(0)), tlv(2, Buffer.from('192.168.0.137')), tlv(3, u16(50000)), tlv(4, u16(50001))])),
        tlv(4, Buffer.concat([tlv(1, u8(0)), tlv(2, Buffer.alloc(16, 1)), tlv(3, Buffer.alloc(14, 2))])),
        tlv(5, Buffer.concat([tlv(1, u8(0)), tlv(2, Buffer.alloc(16, 4)), tlv(3, Buffer.alloc(14, 5))])),
    ]);
    const setup = service.characteristics.find(c => c.UUID.startsWith('00000118'));
    // emulate the HAP connection hap-nodejs passes in, which is the address fallback.
    const fakeConnection: any = { getLocalAddress: () => '127.0.0.1' };
    await (setup as any).handleSetRequest(write.toString('base64'), fakeConnection);
    const resp = decodeWithLists(Buffer.from(await (setup as any).handleGetRequest(), 'base64'));
    const status = (resp[2] as Buffer)[0];
    const addr = decodeWithLists(resp[3] as Buffer);
    console.log('setup status', status, 'accessory addr', (addr[2] as Buffer).toString(), 'vport', (addr[3] as Buffer).readUInt16LE(0), 'ssrc', (resp[6] as Buffer).readUInt32LE(0));
    if (status !== 0) throw new Error('setup endpoints failed, status ' + status);
    if (!(resp[1] as Buffer).equals(sessionId)) throw new Error('session id not echoed');
    if (!(addr[3] as Buffer).readUInt16LE(0)) throw new Error('no accessory video port bound');
    if ((addr[2] as Buffer).toString() !== '127.0.0.1') throw new Error('accessory address fallback not used, got: ' + (addr[2] as Buffer).toString());

    // Streaming control: END on a session that never started must be NO_SUCH_STREAM (2).
    const control = service.characteristics.find(c => c.UUID.startsWith('00008045'));
    const endWrite = Buffer.concat([tlv(1, sessionId), tlv(2, u8(1))]);
    const ctlResp = decodeWithLists(Buffer.from(await (control as any).handleSetRequest(endWrite.toString('base64')) as string, 'base64'));
    console.log('control END status', (ctlResp[2] as Buffer)[0]);
    if ((ctlResp[2] as Buffer)[0] !== 2) throw new Error('expected NO_SUCH_STREAM for unstarted session');

    // Unknown session must be status 1.
    const bogus = Buffer.concat([tlv(1, Buffer.alloc(16, 9)), tlv(2, u8(1))]);
    const ctl2 = decodeWithLists(Buffer.from(await (control as any).handleSetRequest(bogus.toString('base64')) as string, 'base64'));
    console.log('control unknown-session status', (ctl2[2] as Buffer)[0]);
    if ((ctl2[2] as Buffer)[0] !== 1) throw new Error('expected UNKNOWN_SESSION');

    console.log('MTR SELFTEST OK');
}
main().then(() => process.exit(0)).catch(e => { console.error('MTR SELFTEST FAILED', e); process.exit(1); });
