import 'package:flutter/services.dart';

/// Sends touch/key events to the AccessibilityService via platform channel.
/// The AccessibilityService injects them as real Android gestures.
class TouchService {
  static const _ch = MethodChannel('com.phoneremote/touch');

  // All coordinates are 0-1 normalized — Kotlin converts to actual pixels
  Future<void> tap(double nx, double ny) => _invoke('tap', {'x': nx, 'y': ny});

  Future<void> swipe(double x1, double y1, double x2, double y2, int ms) =>
      _invoke('swipe', {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'ms': ms});

  Future<void> scroll(double nx, double ny, double dx, double dy) =>
      _invoke('scroll', {'x': nx, 'y': ny, 'dx': dx, 'dy': dy});

  Future<void> back() => _invoke('keyevent', {'keycode': 'KEYCODE_BACK'});
  Future<void> home() => _invoke('keyevent', {'keycode': 'KEYCODE_HOME'});
  Future<void> recents() => _invoke('keyevent', {'keycode': 'KEYCODE_APP_SWITCH'});

  Future<void> keyevent(String keycode) => _invoke('keyevent', {'keycode': keycode});

  Future<void> typeText(String text) => _invoke('text', {'value': text});

  Future<bool> isAccessibilityEnabled() async {
    try {
      return await _ch.invokeMethod<bool>('isAccessibilityEnabled') ?? false;
    } catch (_) {
      return false;
    }
  }

  Future<void> openAccessibilitySettings() => _invoke('openAccessibilitySettings', {});

  Future<void> handleControl(Map<String, dynamic> msg) async {
    switch (msg['action']) {
      case 'tap':
        await tap((msg['x'] as num).toDouble(), (msg['y'] as num).toDouble());
      case 'swipe':
        await swipe(
          (msg['x1'] as num).toDouble(), (msg['y1'] as num).toDouble(),
          (msg['x2'] as num).toDouble(), (msg['y2'] as num).toDouble(),
          (msg['ms'] as num?)?.toInt() ?? 300,
        );
      case 'scroll':
        await scroll(
          (msg['x'] as num).toDouble(), (msg['y'] as num).toDouble(),
          (msg['dx'] as num).toDouble(), (msg['dy'] as num).toDouble(),
        );
      case 'back': await back();
      case 'home': await home();
      case 'recents': await recents();
      case 'keyevent': await keyevent(msg['keycode'] as String);
      case 'text': await typeText(msg['value'] as String);
    }
  }

  Future<void> _invoke(String method, Map<String, dynamic> args) async {
    try { await _ch.invokeMethod(method, args); } catch (_) {}
  }
}
