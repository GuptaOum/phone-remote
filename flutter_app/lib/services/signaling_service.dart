import 'dart:async';
import 'dart:convert';
import 'package:flutter/services.dart';

typedef MsgHandler = void Function(Map<String, dynamic> msg);

/// Thin bridge to ConnectionForegroundService (Kotlin).
/// The WebSocket lives in Kotlin so it survives Flutter engine death.
class SignalingService {
  static const _ch   = MethodChannel('com.phoneremote/touch');
  static const _evCh = EventChannel('com.phoneremote/events');

  final String serverUrl;
  final MsgHandler onMessage;
  final void Function()? onConnected;
  final void Function()? onDisconnected;

  StreamSubscription? _sub;
  bool _alive = false;
  bool _disposed = false;

  bool get isConnected => _alive;

  SignalingService({
    required this.serverUrl,
    required this.onMessage,
    this.onConnected,
    this.onDisconnected,
  });

  void connect() {
    if (_disposed) return;
    _sub = _evCh.receiveBroadcastStream().listen(_onRaw, onError: (_) {});
  }

  void _onRaw(dynamic data) {
    if (_disposed) return;
    try {
      final msg = jsonDecode(data as String) as Map<String, dynamic>;
      final type = msg['type'] as String?;
      if (type == 'auth_ok') {
        _alive = true;
        onConnected?.call();
      } else if (type == '_disconnected') {
        final was = _alive;
        _alive = false;
        if (was) onDisconnected?.call();
      } else if (type == '_service_stopped') {
        _alive = false;
        onDisconnected?.call();
      } else {
        onMessage(msg);
      }
    } catch (_) {}
  }

  void send(Map<String, dynamic> msg) {
    if (_disposed) return;
    try {
      _ch.invokeMethod('wsSend', {'json': jsonEncode(msg)});
    } catch (_) {}
  }

  void dispose() {
    _disposed = true;
    _sub?.cancel();
    _sub = null;
  }
}
