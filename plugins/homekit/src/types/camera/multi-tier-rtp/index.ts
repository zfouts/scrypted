// iOS 27 Camera Multi-Tier RTP Stream Management (HKSV guide section 3.6, service 0x8031).
//
// Removing the legacy RTP Stream Management service made iOS 27 stop treating the accessory
// as a camera entirely, which means the WebRTC service alone is not sufficient: the controller
// still expects an RTP stream management service. This is the new one, carrying HEVC tiers.
//
// It reuses the standard HAP Setup Endpoints and Supported RTP Configuration characteristics,
// and adds Supported Video/Audio Stream Tiers and RTP Streaming Control from the new spec.
// Only a single HEVC + Opus live view stream is implemented.

import { bindUdp, closeQuiet } from '@scrypted/common/src/listen-cluster';
import { getSpsPpsVps } from '@scrypted/common/src/sdp-utils';
import { RtpPacket } from '@koush/werift-src/packages/rtp/src/index';
import { ProtectionProfileAes128CmHmacSha1_80 } from '@koush/werift-src/packages/rtp/src/srtp/const';
import sdk, { FFmpegInput, Intercom, RequestMediaStreamOptions, ScryptedDevice, ScryptedMimeTypes, VideoCamera } from '@scrypted/sdk';
import dgram from 'dgram';
import net from 'net';
import os from 'os';
import { startRtpForwarderProcess } from '../../../../../webrtc/src/rtp-forwarders';
import { getScryptedServerAddress, getScryptedServerAddresses } from '../../../address-override';
import { Accessory, Characteristic, Service } from '../../../hap';
import { createCameraStreamSender } from '../camera-streaming-srtp-sender';
import { HksvVideoCodec } from '../hksv-webrtc/definitions';
import { decode, fromValue, readUInt32, single, tlv, toValue, uint16, uint32, uint8 } from '../hksv-webrtc/tlv';

const { mediaManager } = sdk;

// Pinned payload types, matching the advertised tiers.
const H265_PAYLOAD_TYPE = 100;
const OPUS_PAYLOAD_TYPE = 111;

function hapUUID(short: string) {
    return `0000${short}-0000-1000-8000-0026BB765291`;
}

class SupportedVideoStreamTiers extends Characteristic {
    static readonly UUID = hapUUID('8043');
    constructor() {
        super('Supported Video Stream Tiers', SupportedVideoStreamTiers.UUID, {
            format: 'tlv8' as any,
            perms: ['pr', 'ev'] as any,
        });
        this.value = this.getDefaultValue();
    }
}

class SupportedAudioStreamTiers extends Characteristic {
    static readonly UUID = hapUUID('8044');
    constructor() {
        super('Supported Audio Stream Tiers', SupportedAudioStreamTiers.UUID, {
            format: 'tlv8' as any,
            perms: ['pr', 'ev'] as any,
        });
        this.value = this.getDefaultValue();
    }
}

class RTPStreamingControl extends Characteristic {
    static readonly UUID = hapUUID('8045');
    constructor() {
        super('RTP Streaming Control', RTPStreamingControl.UUID, {
            format: 'tlv8' as any,
            perms: ['pr', 'pw', 'wr'] as any,
        });
        this.value = this.getDefaultValue();
    }
}

class StreamingEnabled extends Characteristic {
    static readonly UUID = hapUUID('8041');
    constructor() {
        super('Streaming Enabled', StreamingEnabled.UUID, {
            format: 'bool' as any,
            perms: ['pr', 'pw', 'ev', 'tw', 'aa'] as any,
        });
        this.value = true;
    }
}

class SensorUUIDCharacteristic extends Characteristic {
    static readonly UUID = hapUUID('805B');
    constructor() {
        super('Sensor UUID', SensorUUIDCharacteristic.UUID, {
            format: 'data' as any,
            perms: ['pr'] as any,
        });
        this.value = this.getDefaultValue();
    }
}

class CameraMultiTierRTPStreamManagementService extends Service {
    static readonly UUID = hapUUID('8031');
    constructor(displayName?: string, subtype?: string) {
        super(displayName, CameraMultiTierRTPStreamManagementService.UUID, subtype);
        this.addCharacteristic(StreamingEnabled);
        this.addCharacteristic(Characteristic.StatusActive);
        this.addCharacteristic(SupportedVideoStreamTiers);
        this.addCharacteristic(SupportedAudioStreamTiers);
        this.addCharacteristic(Characteristic.SupportedRTPConfiguration);
        this.addCharacteristic(Characteristic.SetupEndpoints);
        this.addCharacteristic(RTPStreamingControl);
        this.addCharacteristic(SensorUUIDCharacteristic);
    }
}

export interface RtpVideoTier {
    id: number;
    quality: number;
    width: number;
    height: number;
    fps: number;
    averageKbps: number;
    peakKbps: number;
}

const AUDIO_TIER_ID = 1;

function tlvList(type: number, values: Buffer[]) {
    const parts: Buffer[] = [];
    values.forEach((value, index) => {
        if (index)
            parts.push(Buffer.from([0, 0]));
        parts.push(tlv(type, value));
    });
    return Buffer.concat(parts);
}

// 4.3 Video Stream Tier TLV8
function encodeVideoTier(tier: RtpVideoTier) {
    return Buffer.concat([
        tlv(1, uint32(tier.id)),
        tlv(2, uint8(tier.quality)),
        tlv(3, uint32(tier.averageKbps)),
        tlv(4, uint16(tier.width)),
        tlv(5, uint16(tier.height)),
        tlv(6, uint8(tier.fps)),
    ]);
}

function encodeSupportedVideoStreamTiers(tiers: RtpVideoTier[]) {
    return Buffer.concat([
        tlv(1, uint8(HksvVideoCodec.H265)),
        tlv(2, uint8(H265_PAYLOAD_TYPE)),
        tlvList(3, tiers.map(encodeVideoTier)),
    ]);
}

// 4.4 Audio Stream Tier TLV8: Opus, 48 kHz, 16-bit, 20 ms, mono.
function encodeSupportedAudioStreamTiers() {
    const tier = Buffer.concat([
        tlv(1, uint32(AUDIO_TIER_ID)),
        tlv(2, uint32(32000)),
        tlv(3, uint8(4)),
        tlv(4, uint8(2)),
        tlv(5, uint8(20)),
        tlv(6, uint8(1)),
    ]);
    return Buffer.concat([
        tlv(1, uint8(3)),
        tlv(2, uint8(OPUS_PAYLOAD_TYPE)),
        tlvList(3, [tier]),
    ]);
}

// Spec 3.6: Supported RTP Configuration must be AES_CM_128_HMAC_SHA1_80 (suite 0).
function encodeSupportedRTPConfiguration() {
    return tlv(2, uint8(0));
}

// Setup Endpoints TLV types (standard HAP).
const SE_SESSION_ID = 1;
const SE_CONTROLLER_ADDRESS = 3;
const SE_VIDEO_SRTP = 4;
const SE_AUDIO_SRTP = 5;
const ADDR_VERSION = 1;
const ADDR_IP = 2;
const ADDR_VIDEO_PORT = 3;
const ADDR_AUDIO_PORT = 4;
const SRTP_CRYPTO = 1;
const SRTP_KEY = 2;
const SRTP_SALT = 3;
const SE_RESP_SESSION_ID = 1;
const SE_RESP_STATUS = 2;
const SE_RESP_ACCESSORY_ADDRESS = 3;
const SE_RESP_VIDEO_SRTP = 4;
const SE_RESP_AUDIO_SRTP = 5;
const SE_RESP_VIDEO_SSRC = 6;
const SE_RESP_AUDIO_SSRC = 7;

// RTP Streaming Control TLV types (spec 4.16).
const RC_SESSION_ID = 1;
const RC_COMMAND = 2;
const RC_VIDEO_TIER = 3;
const RC_VIDEO_SSRC = 4;
const RC_AUDIO_SSRC = 6;
const RC_STATUS = 2;
const RC_CMD_END = 1;
const RC_CMD_START = 2;
const RC_STATUS_SUCCESS = 0;
const RC_STATUS_UNKNOWN_SESSION = 1;
const RC_STATUS_NO_SUCH_STREAM = 2;
const RC_STATUS_ERROR = 4;

interface RtpSession {
    sessionId: Buffer;
    controllerAddress: string;
    addressVersion: 'ipv4' | 'ipv6';
    videoPort: number;
    audioPort: number;
    videoKey: Buffer;
    videoSalt: Buffer;
    audioKey: Buffer;
    audioSalt: Buffer;
    videoReturn: dgram.Socket;
    audioReturn: dgram.Socket;
    videoSsrc: number;
    audioSsrc: number;
    started: boolean;
    kill?: () => void;
}

function randomSsrc() {
    return Math.floor(Math.random() * 0x7fffffff);
}

export async function addMultiTierRtpService(
    accessory: Accessory,
    device: ScryptedDevice & VideoCamera & Intercom,
    console: Console,
    tiers: RtpVideoTier[],
    sensorUUID: Buffer,
) {
    const service = accessory.addService(CameraMultiTierRTPStreamManagementService, 'RTP Stream Management');
    service.updateCharacteristic(Characteristic.StatusActive, true);
    service.updateCharacteristic(SupportedVideoStreamTiers, toValue(encodeSupportedVideoStreamTiers(tiers)));
    service.updateCharacteristic(SupportedAudioStreamTiers, toValue(encodeSupportedAudioStreamTiers()));
    service.updateCharacteristic(Characteristic.SupportedRTPConfiguration, toValue(encodeSupportedRTPConfiguration()));
    service.updateCharacteristic(SensorUUIDCharacteristic, toValue(sensorUUID));

    const sessions = new Map<string, RtpSession>();

    const killSession = (session: RtpSession) => {
        session.kill?.();
        closeQuiet(session.videoReturn);
        closeQuiet(session.audioReturn);
        sessions.delete(session.sessionId.toString('hex'));
    };

    // Setup Endpoints is write-then-read: store the response and serve it on the next GET.
    let setupResponse = '';
    const setupChar = service.getCharacteristic(Characteristic.SetupEndpoints);
    setupChar.onGet(() => setupResponse);
    setupChar.onSet(async (value, context, connection) => {
        try {
            const items = decode(fromValue(value));
            const sessionId = single(items, SE_SESSION_ID);
            const addrTlv = decode(single(items, SE_CONTROLLER_ADDRESS));
            const addressVersion: 'ipv4' | 'ipv6' = single(addrTlv, ADDR_VERSION)?.[0] === 1 ? 'ipv6' : 'ipv4';
            const controllerAddress = single(addrTlv, ADDR_IP).toString('utf8');
            const videoPort = single(addrTlv, ADDR_VIDEO_PORT).readUInt16LE(0);
            const audioPort = single(addrTlv, ADDR_AUDIO_PORT).readUInt16LE(0);

            const videoSrtp = decode(single(items, SE_VIDEO_SRTP));
            const audioSrtp = decode(single(items, SE_AUDIO_SRTP));

            const socketType = addressVersion === 'ipv6' ? 'udp6' : 'udp4';
            // Prefer a configured Scrypted Server Address, then the address this HAP connection
            // arrived on (which is what hap-nodejs uses for the legacy service). Without a valid
            // address the controller has nowhere to send RTCP and the stream never starts.
            const serverAddresses = await getScryptedServerAddresses();
            const sourceAddress = serverAddresses?.find(a => !!a && net.isIPv6(a) === (addressVersion === 'ipv6'))
                || await getScryptedServerAddress(socketType).catch(() => undefined)
                || connection?.getLocalAddress(addressVersion);
            if (!sourceAddress)
                throw new Error('unable to determine an accessory address for the RTP stream');

            // The configured address may be stale (DHCP change) and not exist on any interface,
            // in which case binding to it throws EADDRNOTAVAIL and the stream never starts.
            // Fall back to the address the HAP connection arrived on, then to all interfaces.
            const localAddresses = Object.values(os.networkInterfaces()).flat().map(i => i?.address);
            const bindCandidates = [
                sourceAddress,
                connection?.getLocalAddress(addressVersion),
                undefined,
            ].filter((address, index, self) => self.indexOf(address) === index);

            let videoReturn: dgram.Socket;
            let audioReturn: dgram.Socket;
            let videoLocalPort: number;
            let audioLocalPort: number;
            let boundAddress: string;
            let bindError: any;
            for (const candidate of bindCandidates) {
                if (candidate && !localAddresses.includes(candidate)) {
                    console.warn(`Address ${candidate} is not present on any local interface, trying the next candidate.`);
                    continue;
                }
                const video = dgram.createSocket(socketType);
                const audio = dgram.createSocket(socketType);
                try {
                    videoLocalPort = (await bindUdp(video, 0, candidate)).port;
                    audioLocalPort = (await bindUdp(audio, 0, candidate)).port;
                    videoReturn = video;
                    audioReturn = audio;
                    boundAddress = candidate || connection?.getLocalAddress(addressVersion) || sourceAddress;
                    break;
                }
                catch (e) {
                    bindError = e;
                    closeQuiet(video);
                    closeQuiet(audio);
                }
            }
            if (!videoReturn || !boundAddress)
                throw bindError || new Error('unable to bind RTP sockets for the stream');

            videoReturn.setSendBufferSize(1024 * 1024);
            audioReturn.setSendBufferSize(1024 * 1024);

            const session: RtpSession = {
                sessionId,
                controllerAddress,
                addressVersion,
                videoPort,
                audioPort,
                videoKey: single(videoSrtp, SRTP_KEY),
                videoSalt: single(videoSrtp, SRTP_SALT),
                audioKey: single(audioSrtp, SRTP_KEY),
                audioSalt: single(audioSrtp, SRTP_SALT),
                videoReturn,
                audioReturn,
                videoSsrc: randomSsrc(),
                audioSsrc: randomSsrc(),
                started: false,
            };
            sessions.set(sessionId.toString('hex'), session);

            const accessoryAddress = Buffer.concat([
                tlv(ADDR_VERSION, uint8(addressVersion === 'ipv6' ? 1 : 0)),
                tlv(ADDR_IP, boundAddress),
                tlv(ADDR_VIDEO_PORT, uint16(videoLocalPort)),
                tlv(ADDR_AUDIO_PORT, uint16(audioLocalPort)),
            ]);
            const echoVideoSrtp = Buffer.concat([
                tlv(SRTP_CRYPTO, uint8(0)),
                tlv(SRTP_KEY, session.videoKey),
                tlv(SRTP_SALT, session.videoSalt),
            ]);
            const echoAudioSrtp = Buffer.concat([
                tlv(SRTP_CRYPTO, uint8(0)),
                tlv(SRTP_KEY, session.audioKey),
                tlv(SRTP_SALT, session.audioSalt),
            ]);

            setupResponse = toValue(Buffer.concat([
                tlv(SE_RESP_SESSION_ID, sessionId),
                tlv(SE_RESP_STATUS, uint8(0)),
                tlv(SE_RESP_ACCESSORY_ADDRESS, accessoryAddress),
                tlv(SE_RESP_VIDEO_SRTP, echoVideoSrtp),
                tlv(SE_RESP_AUDIO_SRTP, echoAudioSrtp),
                tlv(SE_RESP_VIDEO_SSRC, uint32(session.videoSsrc)),
                tlv(SE_RESP_AUDIO_SSRC, uint32(session.audioSsrc)),
            ]));

            console.log('Multi-Tier RTP setup endpoints', {
                sessionId: sessionId.toString('hex'),
                controllerAddress,
                videoPort,
                audioPort,
                sourceAddress,
                boundAddress,
                videoLocalPort,
                audioLocalPort,
            });
        }
        catch (e) {
            console.error('Multi-Tier RTP setup endpoints failed', e);
            setupResponse = toValue(tlv(SE_RESP_STATUS, uint8(2)));
        }
    });

    const startStream = async (session: RtpSession, tierId: number) => {
        const tier = tiers.find(t => t.id === tierId) || tiers[0];
        const bitrate = (tier.averageKbps || 2000) * 1000;

        const mediaOptions: RequestMediaStreamOptions = {
            destination: 'local',
            destinationId: session.controllerAddress,
            destinationType: '@scrypted/homekit',
            video: {
                codec: 'h265',
                bitrate,
                width: tier.width,
                height: tier.height,
            },
            audio: {
                codec: 'opus',
            },
            tool: 'scrypted',
        };

        const mo = await device.getVideoStream(mediaOptions);
        const ffmpegInput = await mediaManager.convertMediaObjectToJSON<FFmpegInput>(mo, ScryptedMimeTypes.FFmpegInput);

        const srtpConfig = (key: Buffer, salt: Buffer) => ({
            keys: {
                localMasterKey: key,
                localMasterSalt: salt,
                remoteMasterKey: key,
                remoteMasterSalt: salt,
            },
            profile: ProtectionProfileAes128CmHmacSha1_80,
        });

        const videoOptions = {
            maxPacketSize: 1378,
            sps: undefined as Buffer,
            pps: undefined as Buffer,
            vps: undefined as Buffer,
            codec: 'h265' as const,
        };
        const videoSender = createCameraStreamSender(console, srtpConfig(session.videoKey, session.videoSalt),
            session.videoReturn, session.videoSsrc, H265_PAYLOAD_TYPE,
            session.videoPort, session.controllerAddress, 0.5, videoOptions);

        const audioSender = createCameraStreamSender(console, srtpConfig(session.audioKey, session.audioSalt),
            session.audioReturn, session.audioSsrc, OPUS_PAYLOAD_TYPE,
            session.audioPort, session.controllerAddress, 5, undefined,
            { audioPacketTime: 20, audioSampleRate: 24 as any, framesPerPacket: 1 });

        const forwarder = await startRtpForwarderProcess(console, ffmpegInput, {
            video: {
                codecCopy: 'h265',
                packetSize: 1378,
                onMSection: videoSection => {
                    const spsPpsVps = getSpsPpsVps(videoSection);
                    videoOptions.sps = spsPpsVps?.sps;
                    videoOptions.pps = spsPpsVps?.pps;
                    videoOptions.vps = spsPpsVps?.vps;
                },
                onRtp: rtp => videoSender.sendRtp(RtpPacket.deSerialize(rtp)),
                firstPacket: () => videoSender.sendRtcp(),
                encoderArguments: [],
            },
            audio: {
                codecCopy: 'opus',
                packetSize: 400,
                onRtp: rtp => audioSender.sendRtp(RtpPacket.deSerialize(rtp)),
                firstPacket: () => audioSender.sendRtcp(),
                encoderArguments: [
                    '-acodec', 'libopus',
                    '-application', 'lowdelay',
                    '-frame_duration', '20',
                    '-flags', '+global_header',
                    '-ar', '24k',
                    '-b:a', '24k',
                    '-ac', '1',
                ],
            },
        });

        forwarder.killPromise.finally(() => killSession(session));
        session.kill = () => forwarder.kill();
        session.started = true;
        console.log('Multi-Tier RTP HEVC stream started', {
            sessionId: session.sessionId.toString('hex'),
            tier: tier.id,
            width: tier.width,
            height: tier.height,
            sourceCodec: ffmpegInput.mediaStreamOptions?.video?.codec,
        });
    };

    let controlResponse = '';
    const controlChar = service.getCharacteristic(RTPStreamingControl);
    controlChar.onGet(() => controlResponse);
    controlChar.onSet(async value => {
        const items = decode(fromValue(value));
        const sessionId = single(items, RC_SESSION_ID);
        const command = single(items, RC_COMMAND)?.[0];
        const session = sessionId ? sessions.get(sessionId.toString('hex')) : undefined;

        const respond = (status: number) => {
            controlResponse = toValue(Buffer.concat([
                ...(sessionId ? [tlv(RC_SESSION_ID, sessionId)] : []),
                tlv(RC_STATUS, uint8(status)),
            ]));
            return controlResponse;
        };

        console.log('Multi-Tier RTP streaming control', {
            sessionId: sessionId?.toString('hex'),
            command,
            known: !!session,
        });

        if (!session)
            return respond(RC_STATUS_UNKNOWN_SESSION);

        if (command === RC_CMD_END) {
            if (!session.started)
                return respond(RC_STATUS_NO_SUCH_STREAM);
            killSession(session);
            return respond(RC_STATUS_SUCCESS);
        }

        if (command === RC_CMD_START) {
            const tierId = readUInt32(single(items, RC_VIDEO_TIER)) ?? tiers[0].id;
            const videoSsrc = readUInt32(single(items, RC_VIDEO_SSRC));
            if (videoSsrc)
                session.videoSsrc = videoSsrc;
            const audioSsrc = readUInt32(single(items, RC_AUDIO_SSRC));
            if (audioSsrc)
                session.audioSsrc = audioSsrc;
            try {
                await startStream(session, tierId);
                return respond(RC_STATUS_SUCCESS);
            }
            catch (e) {
                console.error('Multi-Tier RTP start failed', e);
                killSession(session);
                return respond(RC_STATUS_ERROR);
            }
        }

        return respond(RC_STATUS_ERROR);
    });

    return {
        service,
        closeAll() {
            for (const session of [...sessions.values()])
                killSession(session);
        },
    };
}
