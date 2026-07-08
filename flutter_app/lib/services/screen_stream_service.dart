import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'signaling_service.dart';

class ScreenStreamService {
  static const _ch = MethodChannel('com.phoneremote/screen');

  final SignalingService signaling;
  RTCPeerConnection? _pc;
  MediaStream? _stream;
  bool _active = false;

  ScreenStreamService({required this.signaling});

  Future<bool> start() async {
    if (_active) return true;
    return _startNativeFallback();
  }

  Future<void> handleAnswer(String sdp) async {
    await _pc?.setRemoteDescription(RTCSessionDescription(sdp, 'answer'));
  }

  Future<void> handleIce(Map<String, dynamic> c) async {
    await _pc?.addCandidate(
      RTCIceCandidate(c['candidate'], c['sdpMid'], c['sdpMLineIndex'])
    );
  }

  Future<bool> _startWebRTC() async {
    try {
      _stream = await navigator.mediaDevices.getDisplayMedia({
        'video': true,
        'audio': false,
      });

      _pc = await createPeerConnection({
        'iceServers': [
          {'urls': ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']},
          {
            'urls': ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443',
                     'turns:openrelay.metered.ca:443'],
            'username': 'openrelayproject',
            'credential': 'openrelayproject',
          },
        ],
      });

      _pc!.onIceCandidate = (RTCIceCandidate c) {
        if (c.candidate != null) {
          signaling.send({'type': 'ice', 'candidate': c.toMap()});
        }
      };

      for (final track in _stream!.getTracks()) {
        await _pc!.addTrack(track, _stream!);
      }

      final offer = await _pc!.createOffer();
      await _pc!.setLocalDescription(offer);
      signaling.send({'type': 'offer', 'sdp': offer.sdp});

      _active = true;
      return true;
    } catch (_) {
      await _stream?.dispose();
      await _pc?.close();
      _stream = null;
      _pc = null;
      return false;
    }
  }

  // Kotlin captures JPEG frames via MediaProjection and sends them directly over WebSocket
  Future<bool> _startNativeFallback() async {
    try {
      await _ch.invokeMethod('startCapture');
      _active = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> stop() async {
    _active = false;
    await _stream?.dispose();
    await _pc?.close();
    _pc = null; _stream = null;
    try { await _ch.invokeMethod('stopCapture'); } catch (_) {}
  }

  bool get isActive => _active;
  MediaStream? get localStream => _stream;
}
