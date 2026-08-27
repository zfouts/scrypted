// HomeKit Secure Video Open Source Compatibility Guide (Developer Preview, 2026-06-03)
// Services and characteristics for the iOS 27 / tvOS 27 camera pipeline:
// https://developer.apple.com/download/files/HomeKit-Secure-Video-Open-Source-Compatibility-Guide.pdf
//
// Only the pieces needed for live view over WebRTC (HEVC/H.264 + Opus) are defined here.
// Recording via CMAF ingest (Buffer Management, Key Management, Client Certificate Management)
// is not implemented; the existing HKSV fMP4-over-HDS recording path is left untouched.

import { Characteristic, Service } from '../../../hap';

function hapUUID(short: string) {
    return `0000${short}-0000-1000-8000-0026BB765291`;
}

// string literals are used rather than the Formats/Perms const enums, since const enums
// exported from hap-nodejs d.ts files do not survive the babel/webpack build.
const TLV8 = 'tlv8';
const BOOL = 'bool';
const UINT8 = 'uint8';
const DATA = 'data';
const PAIRED_READ = 'pr';
const PAIRED_WRITE = 'pw';
const NOTIFY = 'ev';
const WRITE_RESPONSE = 'wr';
const TIMED_WRITE = 'tw';
const ADMIN_ONLY = 'aa';

type Perms = any;

// 4.1 Sensor UUID
export class SensorUUID extends Characteristic {
    static readonly UUID = hapUUID('805B');
    constructor() {
        super('Sensor UUID', SensorUUID.UUID, {
            format: DATA,
            perms: [PAIRED_READ] as Perms,
        });
        this.value = this.getDefaultValue();
    }
}

// 4.5 Camera Capabilities
export class CameraCapabilities extends Characteristic {
    static readonly UUID = hapUUID('8011');
    constructor() {
        super('Camera Capabilities', CameraCapabilities.UUID, {
            format: TLV8,
            perms: [PAIRED_READ] as Perms,
        });
        this.value = this.getDefaultValue();
    }
}

// 4.15 Streaming Enabled
export class StreamingEnabled extends Characteristic {
    static readonly UUID = hapUUID('8041');
    constructor() {
        super('Streaming Enabled', StreamingEnabled.UUID, {
            format: BOOL,
            perms: [PAIRED_READ, PAIRED_WRITE, NOTIFY, TIMED_WRITE, ADMIN_ONLY] as Perms,
        });
        this.value = this.getDefaultValue();
    }
}

// 4.17 WebRTC Solicit Offer
export class WebRTCSolicitOffer extends Characteristic {
    static readonly UUID = hapUUID('8053');
    constructor() {
        super('WebRTC Solicit Offer', WebRTCSolicitOffer.UUID, {
            format: TLV8,
            perms: [PAIRED_READ, PAIRED_WRITE, WRITE_RESPONSE] as Perms,
        });
        this.value = this.getDefaultValue();
    }
}

// 4.18 WebRTC Provide Answer
export class WebRTCProvideAnswer extends Characteristic {
    static readonly UUID = hapUUID('8054');
    constructor() {
        super('WebRTC Provide Answer', WebRTCProvideAnswer.UUID, {
            format: TLV8,
            perms: [PAIRED_READ, PAIRED_WRITE, WRITE_RESPONSE] as Perms,
        });
        this.value = this.getDefaultValue();
    }
}

// 4.19 WebRTC Streaming Control
export class WebRTCStreamingControl extends Characteristic {
    static readonly UUID = hapUUID('8056');
    constructor() {
        super('WebRTC Streaming Control', WebRTCStreamingControl.UUID, {
            format: TLV8,
            perms: [PAIRED_READ, PAIRED_WRITE, WRITE_RESPONSE] as Perms,
        });
        this.value = this.getDefaultValue();
    }
}

// 4.20 WebRTC Number of Active Sessions
export class WebRTCNumberOfActiveSessions extends Characteristic {
    static readonly UUID = hapUUID('8057');
    constructor() {
        super('WebRTC Number of Active Sessions', WebRTCNumberOfActiveSessions.UUID, {
            format: UINT8,
            perms: [PAIRED_READ, NOTIFY] as Perms,
            minValue: 0,
            maxValue: 255,
            minStep: 1,
        });
        this.value = 0;
    }
}

// 4.21 WebRTC Reoffer
export class WebRTCReoffer extends Characteristic {
    static readonly UUID = hapUUID('8058');
    constructor() {
        super('WebRTC Reoffer', WebRTCReoffer.UUID, {
            format: TLV8,
            perms: [PAIRED_READ, PAIRED_WRITE, WRITE_RESPONSE] as Perms,
        });
        this.value = this.getDefaultValue();
    }
}

// 4.22 WebRTC Update Session
export class WebRTCUpdateSession extends Characteristic {
    static readonly UUID = hapUUID('805C');
    constructor() {
        super('WebRTC Update Session', WebRTCUpdateSession.UUID, {
            format: TLV8,
            perms: [PAIRED_READ, PAIRED_WRITE, WRITE_RESPONSE] as Perms,
        });
        this.value = this.getDefaultValue();
    }
}

// 4.23 WebRTC Supported Video Stream Tiers
export class WebRTCSupportedVideoStreamTiers extends Characteristic {
    static readonly UUID = hapUUID('8059');
    constructor() {
        super('WebRTC Supported Video Stream Tiers', WebRTCSupportedVideoStreamTiers.UUID, {
            format: TLV8,
            perms: [PAIRED_READ, NOTIFY] as Perms,
        });
        this.value = this.getDefaultValue();
    }
}

// 4.24 WebRTC Supported Audio Stream Tiers
export class WebRTCSupportedAudioStreamTiers extends Characteristic {
    static readonly UUID = hapUUID('805A');
    constructor() {
        super('WebRTC Supported Audio Stream Tiers', WebRTCSupportedAudioStreamTiers.UUID, {
            format: TLV8,
            perms: [PAIRED_READ, NOTIFY] as Perms,
        });
        this.value = this.getDefaultValue();
    }
}

// 3.1 Camera Capabilities Service
export class CameraCapabilitiesService extends Service {
    static readonly UUID = hapUUID('8010');
    constructor(displayName?: string, subtype?: string) {
        super(displayName, CameraCapabilitiesService.UUID, subtype);
        this.addCharacteristic(Characteristic.Version);
        this.addCharacteristic(CameraCapabilities);
        this.addOptionalCharacteristic(Characteristic.ManuallyDisabled);
    }
}

// 3.2 Camera Global Operating Mode Service
export class CameraGlobalOperatingModeService extends Service {
    static readonly UUID = hapUUID('8032');
    constructor(displayName?: string, subtype?: string) {
        super(displayName, CameraGlobalOperatingModeService.UUID, subtype);
        this.addCharacteristic(Characteristic.HomeKitCameraActive);
        this.addCharacteristic(StreamingEnabled);
        this.addCharacteristic(Characteristic.CameraOperatingModeIndicator);
        this.addOptionalCharacteristic(Characteristic.ManuallyDisabled);
        this.addOptionalCharacteristic(Characteristic.NightVision);
        this.addOptionalCharacteristic(Characteristic.ThirdPartyCameraActive);
    }
}

// 3.7 Camera WebRTC Stream Management Service
export class CameraWebRTCStreamManagementService extends Service {
    static readonly UUID = hapUUID('8033');
    constructor(displayName?: string, subtype?: string) {
        super(displayName, CameraWebRTCStreamManagementService.UUID, subtype);
        this.addCharacteristic(WebRTCSolicitOffer);
        this.addCharacteristic(WebRTCProvideAnswer);
        this.addCharacteristic(WebRTCStreamingControl);
        this.addCharacteristic(WebRTCNumberOfActiveSessions);
        this.addCharacteristic(WebRTCReoffer);
        this.addCharacteristic(WebRTCUpdateSession);
        this.addCharacteristic(WebRTCSupportedVideoStreamTiers);
        this.addCharacteristic(WebRTCSupportedAudioStreamTiers);
        this.addCharacteristic(StreamingEnabled);
        this.addCharacteristic(SensorUUID);
    }
}

// Enumerations from the spec.
export enum HksvVideoCodec {
    H264 = 1,
    H265 = 2,
}

export enum HksvVideoQuality {
    Highest = 1,
    High = 2,
    Medium = 3,
    Low = 4,
}

export enum HksvAudioCodec {
    Opus = 3,
}

export enum HksvAudioSampleRate {
    KHZ_16 = 1,
    KHZ_24 = 2,
    KHZ_32 = 3,
    KHZ_48 = 4,
}

export enum HksvAudioBitDepth {
    BITS_8 = 1,
    BITS_16 = 2,
    BITS_24 = 3,
}

export enum WebRTCSolicitStatus {
    Success = 0,
    PrivacyModeActive = 1,
    Error = 2,
}

export enum WebRTCStreamingStatus {
    Success = 0,
    UnknownSessionIdentifier = 1,
    Busy = 2,
    Error = 3,
}

export enum WebRTCStreamingCommand {
    End = 1,
}
