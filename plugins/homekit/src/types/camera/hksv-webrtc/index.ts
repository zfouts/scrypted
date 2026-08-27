// iOS 27 / tvOS 27 live view: WebRTC (HEVC or H.264 + Opus) negotiated over HAP characteristics.
// See the HomeKit Secure Video Open Source Compatibility Guide, sections 3.1, 3.2, 3.7, 4.17-4.24 and 5.

import { Deferred } from '@scrypted/common/src/deferred';
import { Intercom, MediaObject, RequestMediaStreamOptions, ResponseMediaStreamOptions, RTCSignalingOptions, ScryptedDevice, ScryptedInterface, VideoCamera } from '@scrypted/sdk';
import crypto from 'crypto';
import { createTrackForwarder } from '../../../../../webrtc/src/ffmpeg-to-wrtc';
import { logConnectionState, waitClosed, waitConnected, waitIceConnected } from '../../../../../webrtc/src/peerconnection-util';
import { ScryptedSessionControl } from '../../../../../webrtc/src/session-control';
import { logIsLocalIceTransport } from '../../../../../webrtc/src/werift-util';
import { MediaStreamTrack, RTCIceCandidate, RTCPeerConnection, RTCRtpCodecParameters, RTCRtpTransceiver } from '@koush/werift-src/packages/webrtc/src/index';
import { Accessory, Characteristic, Service } from '../../../hap';
import type { HomeKitPlugin } from '../../../main';
import {
    CameraCapabilities,
    CameraCapabilitiesService,
    CameraGlobalOperatingModeService,
    CameraWebRTCStreamManagementService,
    HksvAudioBitDepth,
    HksvAudioCodec,
    HksvAudioSampleRate,
    HksvVideoCodec,
    HksvVideoQuality,
    SensorUUID,
    StreamingEnabled,
    WebRTCNumberOfActiveSessions,
    WebRTCProvideAnswer,
    WebRTCReoffer,
    WebRTCSolicitOffer,
    WebRTCSolicitStatus,
    WebRTCStreamingCommand,
    WebRTCStreamingControl,
    WebRTCStreamingStatus,
    WebRTCSupportedAudioStreamTiers,
    WebRTCSupportedVideoStreamTiers,
    WebRTCUpdateSession,
} from './definitions';
import { decode, fromValue, list, readUInt16, single, tlv, tlvList, toValue, uint16, uint32, uint8 } from './tlv';

// Version string mandated by the developer preview for Camera Capabilities (3.1).
export const HKSV_CAPABILITIES_VERSION = '17.99';

// Payload types advertised in the tier characteristics. These must match the SDP offer,
// so they are pinned here rather than letting werift allocate them.
const H265_PAYLOAD_TYPE = 100;
const H264_PAYLOAD_TYPE = 102;
const OPUS_PAYLOAD_TYPE = 111;

const MAX_SESSIONS = 6;

// Tier identifiers are arbitrary but must be stable.
const TIER_ID_HIGH = 1;
const TIER_ID_MEDIUM = 2;
const TIER_ID_LOW = 3;
const AUDIO_TIER_ID = 1;

interface VideoTier {
    id: number;
    quality: HksvVideoQuality;
    width: number;
    height: number;
    fps: number;
    averageKbps: number;
    peakKbps: number;
}

// Bitrate targets from section 2, "Minimum Requirements".
function bitratesForHeight(height: number) {
    if (height >= 2160)
        return { averageKbps: 4500, peakKbps: 5000 };
    if (height >= 1440)
        return { averageKbps: 2800, peakKbps: 3000 };
    if (height >= 1080)
        return { averageKbps: 1700, peakKbps: 1800 };
    if (height >= 720)
        return { averageKbps: 768, peakKbps: 800 };
    return { averageKbps: 180, peakKbps: 190 };
}

function videoCodecParameters(mimeType: string, payloadType: number, parameters: string) {
    return new RTCRtpCodecParameters({
        mimeType,
        clockRate: 90000,
        payloadType,
        rtcpFeedback: [
            { type: 'transport-cc' },
            { type: 'ccm', parameter: 'fir' },
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' },
            { type: 'goog-remb' },
        ],
        parameters,
    });
}

const h265Codec = videoCodecParameters('video/H265', H265_PAYLOAD_TYPE, 'level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST');
const h264Codec = videoCodecParameters('video/H264', H264_PAYLOAD_TYPE, 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640033');
const opusCodec = new RTCRtpCodecParameters({
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    payloadType: OPUS_PAYLOAD_TYPE,
});

// Presented to the shared createTrackForwarder so the source selection behaves like a 4K iPhone
// client: no baseline transcode, full resolution requested, codec switching allowed.
const homeKitClientOptions: RTCSignalingOptions = {
    userAgent: 'HomeKit/iOS27 (Scrypted HKSV WebRTC)',
    capabilities: {
        video: {
            codecs: [
                { mimeType: 'video/H265', clockRate: 90000, sdpFmtpLine: 'level-id=180;profile-id=1' },
                { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'profile-level-id=640033' },
            ],
            headerExtensions: [],
        },
        audio: {
            codecs: [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
            headerExtensions: [],
        },
    },
    screen: {
        devicePixelRatio: 1,
        width: 3840,
        height: 2160,
    },
};

interface WebRTCSession {
    id: Buffer;
    pc: RTCPeerConnection;
    videoTransceiver: RTCRtpTransceiver;
    audioTransceiver: RTCRtpTransceiver;
    control?: ScryptedSessionControl;
    candidates: RTCIceCandidate[];
    startTime: number;
    answered: boolean;
    closed: Deferred<void>;
    forwarderKill?: () => void;
}

function getStorageBoolean(storage: Storage, key: string, defaultValue: boolean) {
    const value = storage.getItem(key);
    if (value === null || value === undefined || value === '')
        return defaultValue;
    return value === 'true';
}

export function isHksvWebRTCEnabled(storage: Storage) {
    return getStorageBoolean(storage, 'hksvWebRTC', false);
}

function getSensorUUID(storage: Storage) {
    let hex = storage.getItem('hksvSensorUUID');
    if (!hex) {
        hex = crypto.randomBytes(16).toString('hex');
        storage.setItem('hksvSensorUUID', hex);
    }
    return Buffer.from(hex, 'hex');
}

function stableUUID(storage: Storage, key: string) {
    let hex = storage.getItem(key);
    if (!hex) {
        hex = crypto.randomBytes(16).toString('hex');
        storage.setItem(key, hex);
    }
    return Buffer.from(hex, 'hex');
}

async function getSensorDimensions(device: ScryptedDevice & VideoCamera, console: Console) {
    let width = 3840;
    let height = 2160;
    try {
        const options: ResponseMediaStreamOptions[] = await device.getVideoStreamOptions();
        let best: { width: number, height: number };
        for (const option of options || []) {
            const w = option?.video?.width;
            const h = option?.video?.height;
            if (!w || !h)
                continue;
            if (!best || w * h > best.width * best.height)
                best = { width: w, height: h };
        }
        if (best) {
            width = best.width;
            height = best.height;
        }
    }
    catch (e) {
        console.warn('Unable to determine sensor dimensions, assuming 4K.', e);
    }
    return { width, height };
}

// Section 2: three encodings per sensor. Tiers are derived from the sensor size, keeping aspect ratio.
function buildTiers(sensor: { width: number, height: number }): VideoTier[] {
    const aspect = sensor.width / sensor.height;
    const even = (n: number) => Math.round(n / 2) * 2;
    const make = (id: number, quality: HksvVideoQuality, height: number, fps: number): VideoTier => {
        const h = Math.min(height, sensor.height);
        const w = even(h * aspect);
        return {
            id,
            quality,
            width: w,
            height: h,
            fps,
            ...bitratesForHeight(h),
        };
    };

    const highHeight = sensor.height >= 2160 ? 2160 : sensor.height >= 1440 ? 1440 : 1080;
    const mediumHeight = highHeight > 1080 ? 1080 : 720;
    return [
        make(TIER_ID_HIGH, HksvVideoQuality.High, highHeight, 30),
        make(TIER_ID_MEDIUM, HksvVideoQuality.Medium, mediumHeight, 30),
        make(TIER_ID_LOW, HksvVideoQuality.Low, 360, 15),
    ];
}

// 4.3 / 4.23 Video Stream Tier TLV8
function encodeVideoTier(tier: VideoTier) {
    return Buffer.concat([
        tlv(1, uint32(tier.id)),
        tlv(2, uint8(tier.quality)),
        tlv(3, uint32(tier.averageKbps)),
        tlv(4, uint16(tier.width)),
        tlv(5, uint16(tier.height)),
        tlv(6, uint8(tier.fps)),
    ]);
}

function encodeSupportedVideoStreamTiers(codec: HksvVideoCodec, payloadType: number, tiers: VideoTier[]) {
    return Buffer.concat([
        tlv(1, uint8(codec)),
        tlv(2, uint8(payloadType)),
        tlvList(3, tiers.map(encodeVideoTier)),
    ]);
}

// 4.4 / 4.24 Audio Stream Tier TLV8. Opus transmits at 48 kHz, 20 ms packets, mono.
function encodeSupportedAudioStreamTiers() {
    const tier = Buffer.concat([
        tlv(1, uint32(AUDIO_TIER_ID)),
        tlv(2, uint32(32000)),
        tlv(3, uint8(HksvAudioSampleRate.KHZ_48)),
        tlv(4, uint8(HksvAudioBitDepth.BITS_16)),
        tlv(5, uint8(20)),
        tlv(6, uint8(1)),
    ]);
    return Buffer.concat([
        tlv(1, uint8(HksvAudioCodec.Opus)),
        tlv(2, uint8(OPUS_PAYLOAD_TYPE)),
        tlvList(3, [tier]),
    ]);
}

// 4.5 Camera Capabilities TLV8
function encodeCameraCapabilities(storage: Storage, sensor: { width: number, height: number }, tiers: VideoTier[]) {
    const streamCapabilities = tiers.map(tier => Buffer.concat([
        tlv(1, stableUUID(storage, `hksvStreamUUID-${tier.id}`)),
        tlv(2, uint8(tier.quality)),
        tlv(3, uint16(tier.width)),
        tlv(4, uint16(tier.height)),
        tlv(5, uint8(tier.fps)),
        tlv(6, uint32(tier.averageKbps)),
        tlv(7, uint32(tier.peakKbps)),
    ]));

    const sensorConfiguration = Buffer.concat([
        tlv(1, Buffer.concat([
            tlv(1, uint16(sensor.width)),
            tlv(2, uint16(sensor.height)),
        ])),
        tlv(2, getSensorUUID(storage)),
        // Sensor Type: Primary
        tlv(3, uint8(1)),
        // Sensor Intent: Main
        tlv(4, uint8(1)),
        tlvList(5, streamCapabilities),
    ]);

    return Buffer.concat([
        tlv(1, uint8(1)),
        tlv(2, tlvList(1, [sensorConfiguration])),
    ]);
}

// 4.17 WebRTC ICE Candidate TLV8
function encodeIceCandidate(candidate: RTCIceCandidate) {
    const parts = [tlv(1, candidate.candidate)];
    if (candidate.sdpMid !== undefined && candidate.sdpMid !== null)
        parts.push(tlv(2, candidate.sdpMid));
    if (candidate.sdpMLineIndex !== undefined && candidate.sdpMLineIndex !== null)
        parts.push(tlv(3, uint16(candidate.sdpMLineIndex)));
    return Buffer.concat(parts);
}

function decodeIceCandidates(candidateTlvs: Buffer[]) {
    const ret: RTCIceCandidateInit[] = [];
    for (const buffer of candidateTlvs) {
        const items = decode(buffer);
        const candidate = single(items, 1)?.toString('utf8');
        if (!candidate)
            continue;
        ret.push({
            candidate,
            sdpMid: single(items, 2)?.toString('utf8'),
            sdpMLineIndex: readUInt16(single(items, 3)),
        });
    }
    return ret;
}

export async function addHksvWebRTCServices(
    accessory: Accessory,
    device: ScryptedDevice & VideoCamera & Intercom,
    console: Console,
    storage: Storage,
    homekitPlugin: HomeKitPlugin,
) {
    const twoWayAudio = device.interfaces?.includes(ScryptedInterface.Intercom);
    const sensor = await getSensorDimensions(device, console);
    const tiers = buildTiers(sensor);
    const preferH265 = getStorageBoolean(storage, 'hksvWebRTCPreferH265', true);

    console.log('HKSV WebRTC (iOS 27) streaming enabled', {
        sensor,
        tiers,
        preferH265,
        twoWayAudio,
    });

    // 3.1 Camera Capabilities
    const capabilitiesService = accessory.addService(CameraCapabilitiesService, 'Camera Capabilities');
    capabilitiesService.updateCharacteristic(Characteristic.Version, HKSV_CAPABILITIES_VERSION);
    capabilitiesService.updateCharacteristic(CameraCapabilities, toValue(encodeCameraCapabilities(storage, sensor, tiers)));

    // 3.2 Camera Global Operating Mode
    const globalOperatingMode = accessory.addService(CameraGlobalOperatingModeService, 'Camera Operating Mode');
    const bindStoredBoolean = (service: Service, characteristic: typeof Characteristic, key: string, defaultValue: boolean) => {
        const c = service.getCharacteristic(characteristic as any);
        c.updateValue(getStorageBoolean(storage, key, defaultValue));
        c.onGet(() => getStorageBoolean(storage, key, defaultValue));
        c.onSet(value => {
            storage.setItem(key, (!!value).toString());
        });
    };
    bindStoredBoolean(globalOperatingMode, Characteristic.HomeKitCameraActive as any, 'hksvHomeKitCameraActive', true);
    bindStoredBoolean(globalOperatingMode, StreamingEnabled as any, 'hksvGlobalStreamingEnabled', true);
    bindStoredBoolean(globalOperatingMode, Characteristic.CameraOperatingModeIndicator as any, 'hksvOperatingModeIndicator', true);

    // 3.7 Camera WebRTC Stream Management
    const webrtcService = accessory.addService(CameraWebRTCStreamManagementService, 'WebRTC Stream Management');
    webrtcService.updateCharacteristic(SensorUUID, toValue(getSensorUUID(storage)));
    webrtcService.updateCharacteristic(WebRTCSupportedVideoStreamTiers, toValue(encodeSupportedVideoStreamTiers(
        preferH265 ? HksvVideoCodec.H265 : HksvVideoCodec.H264,
        preferH265 ? H265_PAYLOAD_TYPE : H264_PAYLOAD_TYPE,
        tiers)));
    webrtcService.updateCharacteristic(WebRTCSupportedAudioStreamTiers, toValue(encodeSupportedAudioStreamTiers()));
    bindStoredBoolean(webrtcService, StreamingEnabled as any, 'hksvWebRTCStreamingEnabled', true);

    const sessions = new Map<string, WebRTCSession>();
    const activeSessions = webrtcService.getCharacteristic(WebRTCNumberOfActiveSessions);
    activeSessions.updateValue(0);

    const updateActiveSessions = () => activeSessions.updateValue(Math.min(255, sessions.size));

    const isStreamingAllowed = () => getStorageBoolean(storage, 'hksvHomeKitCameraActive', true)
        && getStorageBoolean(storage, 'hksvGlobalStreamingEnabled', true)
        && getStorageBoolean(storage, 'hksvWebRTCStreamingEnabled', true);

    const closeSession = (session: WebRTCSession, reason: string) => {
        if (session.closed.finished)
            return;
        session.closed.resolve(undefined);
        sessions.delete(session.id.toString('hex'));
        updateActiveSessions();
        console.log(`HKSV WebRTC session ended (${reason}), duration: ${Math.round((Date.now() - session.startTime) / 1000)}s`);
        session.forwarderKill?.();
        session.control?.endSession();
        session.pc.close().catch(() => { });
    };

    const requestMediaStream = async (options: RequestMediaStreamOptions): Promise<MediaObject> => {
        const merged: RequestMediaStreamOptions = {
            ...options,
            destinationType: '@scrypted/homekit',
            video: {
                ...options?.video,
                // HEVC is the codec the spec is built around. Fall back to H.264 if the source
                // can not provide it; werift selects the matching negotiated payload type.
                codec: preferH265 ? 'h265' : 'h264',
                alternateCodecs: ['h265', 'h264'],
            },
            audio: {
                codec: 'opus',
                alternateCodecs: ['opus', 'pcm_mulaw', 'pcm_alaw'],
            },
        };
        return device.getVideoStream(merged);
    };

    const startForwarder = async (session: WebRTCSession) => {
        const { pc, videoTransceiver, audioTransceiver } = session;
        console.log('HKSV WebRTC waiting for connection');
        if (pc.remoteIsBundled)
            await waitConnected(pc);
        else
            await waitIceConnected(pc);
        if (session.closed.finished)
            return;
        console.log('HKSV WebRTC connected', Date.now() - session.startTime);

        const forwarder = await createTrackForwarder({
            timeStart: session.startTime,
            ...logIsLocalIceTransport(console, pc),
            requestMediaStream,
            videoTransceiver,
            audioTransceiver,
            maximumCompatibilityMode: false,
            clientOptions: homeKitClientOptions,
        });
        if (!forwarder) {
            closeSession(session, 'no media stream');
            return;
        }
        session.forwarderKill = () => forwarder.kill();
        forwarder.killPromise.finally(() => closeSession(session, 'forwarder exited'));

        // talkback: start the intercom once the Home app begins sending audio.
        if (twoWayAudio && session.control) {
            const control = session.control;
            const startTalkback = () => {
                if (session.closed.finished)
                    return;
                console.log('HKSV WebRTC talkback audio detected, starting intercom.');
                control.setPlaybackInternal({ audio: true, video: true }).catch(e => console.error('intercom failed to start', e));
            };
            const track = audioTransceiver.receiver.track;
            if (track)
                track.onReceiveRtp.once(startTalkback);
            else
                audioTransceiver.onTrack.once(track => track.onReceiveRtp.once(startTalkback));
        }
    };

    const createSession = async (): Promise<WebRTCSession> => {
        const pc = new RTCPeerConnection({
            codecs: {
                video: preferH265 ? [h265Codec, h264Codec] : [h264Codec, h265Codec],
                audio: [opusCodec],
            },
            iceUseIpv4: true,
            iceUseIpv6: true,
            bundlePolicy: 'max-bundle',
        });
        logConnectionState(console, pc);

        const vtrack = new MediaStreamTrack({ kind: 'video' });
        const atrack = new MediaStreamTrack({ kind: 'audio' });
        const videoTransceiver = pc.addTransceiver(vtrack, { direction: 'sendonly' });
        const audioTransceiver = pc.addTransceiver(atrack, { direction: twoWayAudio ? 'sendrecv' : 'sendonly' });

        const session: WebRTCSession = {
            id: crypto.randomBytes(16),
            pc,
            videoTransceiver,
            audioTransceiver,
            candidates: [],
            startTime: Date.now(),
            answered: false,
            closed: new Deferred<void>(),
        };
        if (twoWayAudio)
            session.control = new ScryptedSessionControl(device, audioTransceiver);

        pc.onIceCandidate.subscribe(candidate => {
            if (candidate)
                session.candidates.push(candidate);
        });

        waitClosed(pc).finally(() => closeSession(session, 'peer connection closed'));

        // HAP has no trickle ICE; gather everything before handing back the offer.
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        sessions.set(session.id.toString('hex'), session);
        updateActiveSessions();

        // the controller must answer promptly; reap sessions that never get one.
        setTimeout(() => {
            if (!session.answered)
                closeSession(session, 'no answer received');
        }, 30000);

        return session;
    };

    const findSession = (items: ReturnType<typeof decode>) => {
        const id = single(items, 1);
        if (!id)
            return undefined;
        return sessions.get(id.toString('hex'));
    };

    const statusResponse = (id: Buffer | undefined, status: WebRTCStreamingStatus) => toValue(Buffer.concat([
        ...(id ? [tlv(1, id)] : []),
        tlv(2, uint8(status)),
    ]));

    // 4.17 WebRTC Solicit Offer
    webrtcService.getCharacteristic(WebRTCSolicitOffer).onSet(async value => {
        const items = decode(fromValue(value));
        const options = single(items, 1);
        const sframeRequested = !!options && !!single(decode(options), 1)?.[0];

        if (!isStreamingAllowed()) {
            console.warn('HKSV WebRTC offer solicited, but streaming is disabled.');
            return toValue(tlv(4, uint8(WebRTCSolicitStatus.PrivacyModeActive)));
        }

        if (sessions.size >= MAX_SESSIONS) {
            console.warn('HKSV WebRTC offer solicited, but the maximum number of sessions are active.');
            return toValue(tlv(4, uint8(WebRTCSolicitStatus.Error)));
        }

        if (sframeRequested) {
            // SFrame end to end encryption is not implemented. The connection is still DTLS-SRTP
            // protected. No SFrame Configuration is returned, which signals it is unavailable.
            console.warn('HKSV WebRTC controller requested SFrame, which is not supported. Continuing without it.');
        }

        try {
            const session = await createSession();
            const sdp = session.pc.localDescription?.sdp;
            console.log('HKSV WebRTC offer created', {
                sessionId: session.id.toString('hex'),
                candidates: session.candidates.length,
            });
            return toValue(Buffer.concat([
                tlv(1, session.id),
                tlv(2, sdp),
                tlvList(3, session.candidates.map(encodeIceCandidate)),
                tlv(4, uint8(WebRTCSolicitStatus.Success)),
            ]));
        }
        catch (e) {
            console.error('HKSV WebRTC offer failed', e);
            return toValue(tlv(4, uint8(WebRTCSolicitStatus.Error)));
        }
    });

    // 4.18 WebRTC Provide Answer
    webrtcService.getCharacteristic(WebRTCProvideAnswer).onSet(async value => {
        const items = decode(fromValue(value));
        const id = single(items, 1);
        const session = findSession(items);
        if (!session)
            return statusResponse(id, WebRTCStreamingStatus.UnknownSessionIdentifier);
        if (session.answered)
            return statusResponse(id, WebRTCStreamingStatus.Busy);

        const sdp = single(items, 2)?.toString('utf8');
        if (!sdp)
            return statusResponse(id, WebRTCStreamingStatus.Error);

        try {
            session.answered = true;
            await session.pc.setRemoteDescription({ type: 'answer', sdp });
            for (const candidate of decodeIceCandidates(list(items, 3))) {
                try {
                    await session.pc.addIceCandidate(new RTCIceCandidate(candidate));
                }
                catch (e) {
                    console.warn('HKSV WebRTC failed to add candidate', candidate.candidate, e);
                }
            }
            startForwarder(session).catch(e => {
                console.error('HKSV WebRTC streaming failed', e);
                closeSession(session, 'streaming error');
            });
            return statusResponse(id, WebRTCStreamingStatus.Success);
        }
        catch (e) {
            console.error('HKSV WebRTC answer failed', e);
            closeSession(session, 'bad answer');
            return statusResponse(id, WebRTCStreamingStatus.Error);
        }
    });

    // 4.19 WebRTC Streaming Control
    webrtcService.getCharacteristic(WebRTCStreamingControl).onSet(async value => {
        const items = decode(fromValue(value));
        const id = single(items, 1);
        const session = findSession(items);
        if (!session)
            return statusResponse(id, WebRTCStreamingStatus.UnknownSessionIdentifier);
        const command = single(items, 2)?.[0];
        if (command !== WebRTCStreamingCommand.End)
            return statusResponse(id, WebRTCStreamingStatus.Error);
        closeSession(session, 'controller requested end');
        return statusResponse(id, WebRTCStreamingStatus.Success);
    });

    // 4.21 WebRTC Reoffer: the controller renegotiates an existing connection.
    webrtcService.getCharacteristic(WebRTCReoffer).onSet(async value => {
        const items = decode(fromValue(value));
        const id = single(items, 1);
        const session = findSession(items);
        if (!session)
            return statusResponse(id, WebRTCStreamingStatus.UnknownSessionIdentifier);
        const sdp = single(items, 2)?.toString('utf8');
        if (!sdp)
            return statusResponse(id, WebRTCStreamingStatus.Error);
        try {
            await session.pc.setRemoteDescription({ type: 'offer', sdp });
            const answer = await session.pc.createAnswer();
            await session.pc.setLocalDescription(answer);
            return toValue(Buffer.concat([
                tlv(1, id),
                tlv(2, session.pc.localDescription.sdp),
                tlv(3, uint8(WebRTCStreamingStatus.Success)),
            ]));
        }
        catch (e) {
            console.error('HKSV WebRTC reoffer failed', e);
            return toValue(Buffer.concat([
                tlv(1, id),
                tlv(3, uint8(WebRTCStreamingStatus.Error)),
            ]));
        }
    });

    // 4.22 WebRTC Update Session: SFrame key rotation. Accepted as a no-op since SFrame is unsupported.
    webrtcService.getCharacteristic(WebRTCUpdateSession).onSet(async value => {
        const items = decode(fromValue(value));
        const id = single(items, 1);
        const session = findSession(items);
        if (!session)
            return statusResponse(id, WebRTCStreamingStatus.UnknownSessionIdentifier);
        return statusResponse(id, WebRTCStreamingStatus.Success);
    });

    return {
        capabilitiesService,
        globalOperatingMode,
        webrtcService,
        closeAll() {
            for (const session of [...sessions.values()]) {
                closeSession(session, 'shutdown');
            }
        },
    };
}
