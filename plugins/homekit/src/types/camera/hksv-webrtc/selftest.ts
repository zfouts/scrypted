// Offline self-test: TLV round trips, HAP service shape, and a werift offer with pinned payload types.
// Run: npx tsx src/types/camera/hksv-webrtc/selftest.ts
import { decodeWithLists } from '@homebridge/hap-nodejs/dist/lib/util/tlv';
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters } from '@koush/werift-src/packages/webrtc/src/index';
import { Accessory, Characteristic, uuid } from '../../../hap';
import { CameraCapabilitiesService, CameraGlobalOperatingModeService, CameraWebRTCStreamManagementService, WebRTCSolicitOffer, WebRTCSupportedVideoStreamTiers } from './definitions';
import { tlv, tlvList, uint16, uint32, uint8, decode, list, single } from './tlv';

async function main() {
    // 1. TLV list round trip (repeated tiers separated by 0x00 0x00).
    const tier = (id: number) => Buffer.concat([tlv(1, uint32(id)), tlv(4, uint16(3840)), tlv(5, uint16(2160)), tlv(6, uint8(30))]);
    const encoded = Buffer.concat([tlv(1, uint8(2)), tlv(2, uint8(100)), tlvList(3, [tier(1), tier(2), tier(3)])]);
    const decoded = decodeWithLists(encoded);
    const tiers = list(decoded, 3);
    console.log('tiers decoded:', tiers.length, 'codec:', single(decoded, 1)[0], 'pt:', single(decoded, 2)[0]);
    if (tiers.length !== 3) throw new Error('tier list round trip failed');
    const t2 = decode(tiers[1]);
    if (t2[1] && (t2[1] as Buffer).readUInt32LE(0) !== 2) throw new Error('tier id mismatch');

    // long value chunking (> 255 bytes, e.g. an SDP)
    const sdp = 'v=0\r\n'.repeat(200);
    const chunked = decodeWithLists(tlv(2, sdp));
    if ((chunked[2] as Buffer).toString() !== sdp) throw new Error('long tlv chunking failed');
    console.log('long tlv ok, bytes:', sdp.length);

    // 2. HAP representation of the services.
    const accessory = new Accessory('Test Camera', uuid.generate('hksv-selftest'));
    accessory.addService(CameraCapabilitiesService, 'caps').updateCharacteristic(Characteristic.Version, '17.99');
    accessory.addService(CameraGlobalOperatingModeService, 'mode');
    const w = accessory.addService(CameraWebRTCStreamManagementService, 'webrtc');
    w.getCharacteristic(WebRTCSolicitOffer).onSet(async () => 'AQA=');
    for (const s of accessory.services) {
        if (!s.UUID.startsWith('000080')) continue;
        console.log('service', s.UUID.slice(4, 8), s.characteristics.map(c => `${c.UUID.slice(4, 8)}:${c.props.format}:${c.props.perms.join('')}`).join(' '));
    }
    const solicit = accessory.services.flatMap(s => s.characteristics).find(c => c.UUID.startsWith('00008053'));
    if (!solicit?.props.perms.includes('wr' as any)) throw new Error('write response perm missing');

    // 3. werift offer with pinned payload types and gathered candidates.
    const mk = (mimeType: string, payloadType: number, parameters: string) => new RTCRtpCodecParameters({ mimeType, clockRate: 90000, payloadType, parameters, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }] });
    const pc = new RTCPeerConnection({
        codecs: {
            video: [mk('video/H265', 100, 'level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST'), mk('video/H264', 102, 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640033')],
            audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111 })],
        },
        iceUseIpv4: true, iceUseIpv6: false, bundlePolicy: 'max-bundle',
    });
    const candidates: string[] = [];
    pc.onIceCandidate.subscribe(c => c && candidates.push(c.candidate));
    pc.addTransceiver(new MediaStreamTrack({ kind: 'video' }), { direction: 'sendonly' });
    pc.addTransceiver(new MediaStreamTrack({ kind: 'audio' }), { direction: 'sendrecv' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const local = pc.localDescription.sdp;
    const has = (s: string) => local.includes(s);
    console.log('offer: H265 pt100', has('a=rtpmap:100 H265/90000'), 'H264 pt102', has('a=rtpmap:102 H264/90000'), 'opus 111', has('a=rtpmap:111 opus/48000/2'));
    console.log('candidates in sdp:', (local.match(/a=candidate/g) || []).length, 'via event:', candidates.length);
    if (!has('a=rtpmap:100 H265/90000')) throw new Error('H265 not offered at pt 100');
    if (!(local.match(/a=candidate/g) || []).length && !candidates.length) throw new Error('no ice candidates gathered');
    await pc.close();
    console.log('SELFTEST OK');
}

main().then(() => process.exit(0)).catch(e => { console.error('SELFTEST FAILED', e); process.exit(1); });
