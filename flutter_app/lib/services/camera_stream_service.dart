import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'signaling_service.dart';

const _touchCh  = MethodChannel('com.phoneremote/touch');
const _cameraCh = MethodChannel('com.phoneremote/camera');

class CameraStreamService {
  final SignalingService signaling;
  bool _active = false;
  bool _front = true;

  CameraStreamService({required this.signaling});

  bool get isActive => _active;

  Future<bool> start({bool front = true}) async {
    if (_active) return true;
    _front = front;
    try {
      final status = await Permission.camera.request();
      if (!status.isGranted) return false;

      // Start the foreground service (keeps camera alive when screen is off)
      try { await _touchCh.invokeMethod('startCameraService'); } catch (_) {}
      // Give the service ~300 ms to start before we call into it
      await Future.delayed(const Duration(milliseconds: 300));

      // Listen for JPEG frames from Kotlin and relay via WebSocket
      _cameraCh.setMethodCallHandler((call) async {
        if (call.method == 'onCameraFrame' && _active) {
          signaling.send({'type': 'camera_frame', 'data': call.arguments as String});
        }
      });

      await _cameraCh.invokeMethod('startCameraStream', {'front': front});
      _active = true;

      // Tell the browser camera is live
      signaling.send({'type': 'camera_streaming'});
      return true;
    } catch (_) {
      await stop();
      return false;
    }
  }

  // These are kept so home_screen.dart doesn't need changes
  Future<void> handleAnswer(String sdp) async {}
  Future<void> handleIce(Map<String, dynamic> c) async {}

  Future<void> flip() async {
    if (!_active) return;
    final wasFront = _front;
    await stop();
    await start(front: !wasFront);
  }

  Future<void> stop() async {
    _active = false;
    try { await _cameraCh.invokeMethod('stopCameraStream'); } catch (_) {}
    try { await _touchCh.invokeMethod('stopCameraService'); } catch (_) {}
    try { signaling.send({'type': 'camera_stopped'}); } catch (_) {}
  }
}
