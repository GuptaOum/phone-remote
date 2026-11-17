import 'package:flutter/services.dart';

class ScreenStreamService {
  static const _ch = MethodChannel('com.phoneremote/screen');

  bool _active = false;

  Future<bool> start() async {
    if (_active) return true;
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
    try { await _ch.invokeMethod('stopCapture'); } catch (_) {}
  }

  bool get isActive => _active;
}
