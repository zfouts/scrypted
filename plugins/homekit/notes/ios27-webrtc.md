# iOS 27 WebRTC Live View (HKSV Open Source Compatibility Guide)

Apple published the "HomeKit Secure Video Open Source Compatibility Guide" (Developer Preview,
2026-06-03) alongside iOS/tvOS 27. It replaces the legacy SRTP live view with WebRTC negotiated
over HAP characteristics, and makes HEVC mandatory (H.264 remains available), enabling 4K/2K tiers.

Spec: https://developer.apple.com/download/files/HomeKit-Secure-Video-Open-Source-Compatibility-Guide.pdf

## What is implemented (`src/types/camera/hksv-webrtc/`)

| Spec section | Service / characteristic | Status |
| --- | --- | --- |
| 3.1 | Camera Capabilities (`8010`) + Version `17.99` + Camera Capabilities TLV (`8011`) | implemented |
| 3.2 | Camera Global Operating Mode (`8032`) | implemented (values persisted in mixin storage) |
| 3.7 | Camera WebRTC Stream Management (`8033`) | implemented |
| 4.17 | WebRTC Solicit Offer | implemented; offer includes all gathered ICE candidates (no trickle over HAP) |
| 4.18 | WebRTC Provide Answer | implemented, starts the media forwarder once ICE/DTLS connects |
| 4.19 | WebRTC Streaming Control (End) | implemented |
| 4.20 | WebRTC Number of Active Sessions | implemented |
| 4.21 | WebRTC Reoffer | implemented (standard renegotiation) |
| 4.22 | WebRTC Update Session | accepted as a no-op (SFrame keys) |
| 4.23/4.24 | WebRTC Supported Video/Audio Stream Tiers | implemented; High/Medium/Low derived from the sensor size |
| 3.6 | Camera Multi-Tier RTP Stream Management (`8031`) | not implemented |
| 3.5/3.9/3.10 | CMAF recording (Buffer/Key/Client Certificate Management) | not implemented; legacy HKSV HDS recording is unchanged |
| 4.17 | SFrame end-to-end encryption | not implemented; DTLS-SRTP only, no SFrame Configuration is returned |

## Media path

The media pipeline reuses the WebRTC plugin's `createTrackForwarder`, so the behavior matches
Scrypted's own WebRTC clients:

* Stream request: `codec: h265` (or `h264` if "Prefer HEVC" is disabled) with
  `alternateCodecs: ['h265', 'h264']`, full sensor resolution, `adaptive` codec switching and
  picture-loss handling, `destination` local/remote from the ICE candidate pair.
* HEVC and H.264 are copied without transcoding and repacketized to a 1200 byte MTU
  (`H265Repacketizer` / `H264Repacketizer`). Any other codec is transcoded to H.264.
* Audio is Opus at 48 kHz. Two way audio uses the `sendrecv` audio transceiver and starts the
  Scrypted intercom on the first inbound RTP packet.
* Payload types are pinned (H265=100, H264=102, Opus=111) so the tier characteristics match the SDP.
* "Transcode to HEVC (libx265)" (off by default) encodes H.264 sources to HEVC when the controller
  negotiated H265: full resolution, source frame rate, bitrate from the spec's tier table. This is
  CPU intensive; configuring the camera itself to output H.265 is the better option.
* The camera console logs `HKSV WebRTC negotiated codecs` with the codec the session is sending, and
  `Transcoding to HEVC with libx265` when the transcoder is active.

## Enabling

Per camera, in the HomeKit mixin settings: "iOS 27 WebRTC Streaming" (off by default) and
"Prefer HEVC (H.265)" (on by default). Reload the HomeKit plugin afterwards. Cameras must be
paired in Accessory Mode; the services are added to the camera accessory.

## Open questions / assumptions

* The developer preview does not describe how the controller selects a tier for WebRTC sessions.
  A single video track is offered and bitrate adaptation relies on RTCP feedback (REMB/NACK/PLI).
* The tier characteristics appear to carry one codec each; HEVC is advertised when "Prefer HEVC"
  is on, otherwise H.264. Both codecs are always present in the SDP offer.
* Whether iOS 27 requires the Multi-Tier RTP service or the CMAF recording services to be
  present before it uses WebRTC live view is unknown until tested on a device.
