import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:device_info_plus/device_info_plus.dart';
import '../services/signaling_service.dart';
import '../services/screen_stream_service.dart';
import '../services/camera_stream_service.dart';
import '../services/phone_files_service.dart';
import '../services/touch_service.dart';
import '../services/file_service.dart';
import '../services/location_service.dart';
import '../services/auth_service.dart';
import 'files_screen.dart';
import 'login_screen.dart';
import 'setup_screen.dart';

class HomeScreen extends StatefulWidget {
  final String serverUrl;
  final String token;
  final String deviceId;
  const HomeScreen({
    super.key,
    required this.serverUrl,
    required this.token,
    required this.deviceId,
  });
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen>
    with WidgetsBindingObserver, TickerProviderStateMixin {
  static const _connSvc = MethodChannel('com.phoneremote/touch');

  SignalingService? _sig;
  ScreenStreamService? _stream;
  CameraStreamService? _camera;
  PhoneFilesService? _phoneFiles;
  FileService? _files;
  LocationService? _location;
  final _touch = TouchService();

  bool _connected = false;
  bool _streaming = false;
  bool _loading = true;
  bool _a11yEnabled = false;
  String _deviceModel = 'Android Device';
  int _screenW = 0;
  int _screenH = 0;

  late AnimationController _pulseCtrl;
  late Animation<double> _pulseAnim;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _pulseCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1800),
    )..repeat(reverse: false);
    _pulseAnim = CurvedAnimation(parent: _pulseCtrl, curve: Curves.easeOut);
    _init();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _checkA11y();
  }

  Future<void> _checkA11y() async {
    final enabled = await _touch.isAccessibilityEnabled();
    if (mounted) setState(() => _a11yEnabled = enabled);
  }

  Future<void> _init() async {
    try {
      final info = await DeviceInfoPlugin().androidInfo;
      _deviceModel = '${info.manufacturer} ${info.model}';

      final view = WidgetsBinding.instance.platformDispatcher.views.first;
      _screenW = view.physicalSize.width.toInt();
      _screenH = view.physicalSize.height.toInt();
      final screenW = _screenW;
      final screenH = _screenH;

      _files = FileService(serverUrl: widget.serverUrl, token: widget.token);

      _sig = SignalingService(
        serverUrl: widget.serverUrl,
        onConnected: () {
          setState(() => _connected = true);
          _sig!.send({
            'type': 'register',
            'role': 'phone',
            'deviceId': widget.deviceId,
            'deviceName': _deviceModel,
            'screenW': screenW,
            'screenH': screenH,
            'model': _deviceModel,
          });
          _startConnectionService('Connected');
          _location?.start();
        },
        onDisconnected: () {
          setState(() {
            _connected = false;
            _streaming = false;
          });
          _updateConnectionStatus('Reconnecting...');
          _location?.stop();
        },
        onMessage: _onMsg,
      );

      _stream    = ScreenStreamService(signaling: _sig!);
      _camera    = CameraStreamService(signaling: _sig!);
      _phoneFiles = PhoneFilesService(signaling: _sig!);
      _location  = LocationService(sig: _sig!);
      _sig!.connect();

      // Start the Kotlin service — it owns the WebSocket from here on
      _startConnectionService('Connecting...');
      await _checkA11y();
      _requestBatteryOptimization();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Connection failed: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // ── Connection foreground service helpers ─────────────────────────────────

  void _requestBatteryOptimization() {
    try {
      _connSvc.invokeMethod('requestBatteryOptimization');
    } catch (_) {}
  }


  Future<void> _startConnectionService(String status) async {
    try {
      await _connSvc.invokeMethod('startConnectionService', {
        'url': widget.serverUrl,
        'token': widget.token,
        'deviceId': widget.deviceId,
        'status': status,
        'screenW': _screenW,
        'screenH': _screenH,
        'model': _deviceModel,
      });
    } catch (_) {}
  }

  Future<void> _updateConnectionStatus(String status) async {
    try {
      await _connSvc.invokeMethod('updateConnectionStatus', {
        'status': status,
        'url': widget.serverUrl,
      });
    } catch (_) {}
  }

// ── Message handler ───────────────────────────────────────────────────────

  void _onMsg(Map<String, dynamic> msg) {
    switch (msg['type']) {
      case '_auth_error':
        // Server rejected our token — session expired, back to login
        _forceLogout();
        break;
      case 'device_removed':
        _forceLogout();
        break;
      case 'stream_start':
        _handleStreamStart();
        break;
      case 'stream_stop':
        _handleStreamStop();
        break;
      case '_screen_started':
        setState(() { _loading = false; _streaming = true; });
        break;
      case 'answer':
        _stream?.handleAnswer(msg['sdp'] as String);
        break;
      case 'ice':
        _stream?.handleIce(msg['candidate'] as Map<String, dynamic>);
        break;
      case 'control':
        {
          final action = msg['action'] as String?;
          final isNavAction = action == 'back' ||
              action == 'home' ||
              action == 'recents' ||
              action == 'keyevent';
          if (_streaming || isNavAction) _touch.handleControl(msg);
        }
        break;
      case 'pf_list':
      case 'pf_download':
      case 'pf_delete':
      case 'pf_upload_start':
      case 'pf_upload_chunk':
        _phoneFiles?.handle(msg);
        break;
    }
  }

  // ── Stream start/stop (browser-triggered) ─────────────────────────────────

  Future<void> _forceLogout() async {
    await AuthService.logout();
    try { await _connSvc.invokeMethod('stopConnectionService'); } catch (_) {}
    if (!mounted) return;
    Navigator.pushAndRemoveUntil(
      context,
      MaterialPageRoute(builder: (_) => const LoginScreen()),
      (route) => false,
    );
  }

  Future<void> _handleStreamStart() async {
    if (_streaming) return;

    if (!_a11yEnabled) {
      _showA11yDialog();
      return;
    }

    setState(() => _loading = true);
    final ok = await _stream?.start() ?? false;
    // On success, _screen_started from Kotlin will set _streaming = true and clear loading.
    // On failure, clear loading and show error.
    if (!ok) {
      setState(() => _loading = false);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text('Failed to start capture. Grant screen recording permission.')),
        );
      }
    }
  }

  Future<void> _handleStreamStop() async {
    if (!_streaming) return;
    await _stream?.stop();
    if (mounted) setState(() => _streaming = false);
  }

  // ── Accessibility dialog ──────────────────────────────────────────────────

  void _showA11yDialog() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF161822),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Row(children: [
          Icon(Icons.accessibility_new, color: Color(0xFF6366F1)),
          SizedBox(width: 10),
          Text('Accessibility Required'),
        ]),
        content: const Text(
          'Touch control requires the Accessibility Service to be enabled.\n\n'
          '1. Tap "Open Settings" below\n'
          '2. Find "plusU" in the list\n'
          '3. Toggle it ON\n'
          '4. Return to this app',
          style: TextStyle(height: 1.6),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Later'),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFFEC4899),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            ),
            onPressed: () {
              Navigator.pop(ctx);
              _touch.openAccessibilitySettings();
            },
            child: const Text('Open Settings'),
          ),
        ],
      ),
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  Future<void> _logout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Log out?'),
        content: const Text(
            'This phone will disconnect and stop being remotely accessible until you sign in again.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Log out')),
        ],
      ),
    );
    if (ok != true) return;
    await _forceLogout();
  }

  @override
  void dispose() {
    _pulseCtrl.dispose();
    WidgetsBinding.instance.removeObserver(this);
    _camera?.stop();
    _stream?.stop();
    _location?.stop();
    _sig?.dispose();
    super.dispose();
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: const Color(0xFF161822),
        title: Row(children: [
          Container(
            width: 8, height: 8,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: _connected
                  ? const Color(0xFF22C55E)
                  : const Color(0xFFEF4444),
            ),
          ),
          const SizedBox(width: 8),
          Text(_connected ? 'Connected' : 'Reconnecting...',
              style: const TextStyle(fontSize: 15)),
        ]),
        actions: [
          IconButton(
            icon: const Icon(Icons.security_outlined),
            tooltip: 'Permissions',
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => const SetupScreen(isReview: true),
              ),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Log out',
            onPressed: _logout,
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 24),

            // Accessibility warning banner
            if (!_a11yEnabled) ...[
              GestureDetector(
                onTap: _showA11yDialog,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  decoration: BoxDecoration(
                    color: const Color(0xFF2D1B00),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: Colors.amber.shade800),
                  ),
                  child: Row(children: [
                    Icon(Icons.warning_amber_rounded,
                        color: Colors.amber.shade600, size: 20),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'Accessibility service not enabled — tap to set up touch control',
                        style: TextStyle(
                            color: Colors.amber.shade600, fontSize: 13, height: 1.4),
                      ),
                    ),
                    Icon(Icons.chevron_right, color: Colors.amber.shade600, size: 18),
                  ]),
                ),
              ),
              const SizedBox(height: 16),
            ],

            // Animated status orb
            Container(
              padding: const EdgeInsets.symmetric(vertical: 36),
              decoration: BoxDecoration(
                color: const Color(0xFF161822),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: const Color(0xFF272A3D)),
              ),
              child: Center(
                child: AnimatedBuilder(
                  animation: _pulseAnim,
                  builder: (ctx, child) {
                    final orbColor = _connected
                        ? (_streaming
                            ? const Color(0xFFEC4899)
                            : const Color(0xFF22C55E))
                        : const Color(0xFF374151);
                    final ringOpacity = (1 - _pulseAnim.value) *
                        (_connected ? 0.5 : 0.15);
                    final ringScale = 1.0 + _pulseAnim.value * 0.9;
                    return SizedBox(
                      width: 140,
                      height: 140,
                      child: Stack(alignment: Alignment.center, children: [
                        // Outer expanding ring
                        Transform.scale(
                          scale: ringScale,
                          child: Container(
                            width: 100,
                            height: 100,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: orbColor.withOpacity(ringOpacity),
                                width: 2,
                              ),
                            ),
                          ),
                        ),
                        // Mid ring
                        Transform.scale(
                          scale: 1.0 + _pulseAnim.value * 0.4,
                          child: Container(
                            width: 80,
                            height: 80,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: orbColor.withOpacity(
                                  (1 - _pulseAnim.value) *
                                      (_connected ? 0.12 : 0.05)),
                            ),
                          ),
                        ),
                        // Core orb
                        Container(
                          width: 52,
                          height: 52,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: orbColor.withOpacity(0.9),
                            boxShadow: _connected
                                ? [
                                    BoxShadow(
                                      color: orbColor.withOpacity(0.4),
                                      blurRadius: 20,
                                      spreadRadius: 2,
                                    )
                                  ]
                                : [],
                          ),
                          child: _loading
                              ? const Padding(
                                  padding: EdgeInsets.all(14),
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : null,
                        ),
                      ]),
                    );
                  },
                ),
              ),
            ),

            const SizedBox(height: 16),

            // Server URL chip
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: BoxDecoration(
                color: const Color(0xFF161822),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: const Color(0xFF272A3D)),
              ),
              child: Row(children: [
                const Icon(Icons.link, size: 16, color: Color(0xFF6366F1)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    widget.serverUrl,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ]),
            ),

            const SizedBox(height: 24),

            // Files button (no icon)
            SizedBox(
              width: double.infinity,
              height: 50,
              child: OutlinedButton(
                style: OutlinedButton.styleFrom(
                  side: const BorderSide(color: Color(0xFF6366F1)),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14)),
                ),
                onPressed: _files == null
                    ? null
                    : () => Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (_) => FilesScreen(fileService: _files!),
                          ),
                        ),
                child: const Text('Files',
                    style: TextStyle(fontSize: 15, color: Color(0xFF6366F1))),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
