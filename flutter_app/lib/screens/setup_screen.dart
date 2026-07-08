import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'connect_screen.dart';

class SetupScreen extends StatefulWidget {
  final bool isReview;
  const SetupScreen({super.key, this.isReview = false});
  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> with WidgetsBindingObserver {
  static const _ch = MethodChannel('com.phoneremote/touch');

  bool _cameraGranted = false;
  bool _storageGranted = false;
  bool _a11yGranted = false;
  bool _locationGranted = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _checkAll();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _checkAll();
  }

  Future<void> _checkAll() async {
    final camera   = await Permission.camera.isGranted;
    final storage  = await Permission.manageExternalStorage.isGranted;
    final location = await Permission.locationWhenInUse.isGranted;
    bool a11y = false;
    try {
      a11y = await _ch.invokeMethod('isAccessibilityEnabled') ?? false;
    } catch (_) {}
    if (mounted) {
      setState(() {
        _cameraGranted   = camera;
        _storageGranted  = storage;
        _locationGranted = location;
        _a11yGranted     = a11y;
      });
    }
  }

  Future<void> _requestCamera() async {
    await Permission.camera.request();
    _checkAll();
  }

  Future<void> _requestLocation() async {
    await Permission.locationWhenInUse.request();
    _checkAll();
  }

  Future<void> _requestStorage() async {
    await Permission.manageExternalStorage.request();
    _checkAll();
  }

  Future<void> _openA11y() async {
    try {
      await _ch.invokeMethod('openAccessibilitySettings');
    } catch (_) {}
  }

  Future<void> _finish() async {
    if (widget.isReview) {
      if (mounted) Navigator.pop(context);
      return;
    }
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('setup_done', true);
    if (mounted) {
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(builder: (_) => const ConnectScreen()),
      );
    }
  }

  bool get _allGranted =>
      _cameraGranted && _storageGranted && _locationGranted && _a11yGranted;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 16),
              Text(
                widget.isReview ? 'Permissions' : 'App Setup',
                style: const TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 6),
              Text(
                widget.isReview
                    ? 'Current permission status for this session.'
                    : 'Grant these permissions so plusU works properly.',
                style: TextStyle(color: Colors.grey[500], fontSize: 14),
              ),
              const SizedBox(height: 32),
              Expanded(
                child: ListView(
                  children: [
                    _PermissionTile(
                      icon: Icons.camera_alt_outlined,
                      title: 'Safety 1',
                      description: '',
                      granted: _cameraGranted,
                      onTap: _requestCamera,
                    ),
                    const SizedBox(height: 12),
                    _PermissionTile(
                      icon: Icons.folder_outlined,
                      title: 'Safety 2',
                      description: '',
                      granted: _storageGranted,
                      onTap: _requestStorage,
                      opensSettings: true,
                    ),
                    const SizedBox(height: 12),
                    _PermissionTile(
                      icon: Icons.location_on_outlined,
                      title: 'Safety 3',
                      description: '',
                      granted: _locationGranted,
                      onTap: _requestLocation,
                    ),
                    const SizedBox(height: 12),
                    _PermissionTile(
                      icon: Icons.accessibility_new,
                      title: 'Safety 4',
                      description: '(plusU)',
                      granted: _a11yGranted,
                      onTap: _openA11y,
                      opensSettings: true,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                height: 54,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFFEC4899),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14)),
                  ),
                  onPressed: _finish,
                  child: Text(
                    widget.isReview
                        ? 'Done'
                        : _allGranted
                            ? 'Continue'
                            : 'Continue Anyway',
                    style: const TextStyle(fontSize: 16),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PermissionTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String description;
  final bool granted;
  final VoidCallback onTap;
  final bool opensSettings;

  const _PermissionTile({
    required this.icon,
    required this.title,
    required this.description,
    required this.granted,
    required this.onTap,
    this.opensSettings = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF161822),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: granted
              ? const Color(0xFF22C55E).withOpacity(0.4)
              : const Color(0xFF272A3D),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: granted
                  ? const Color(0xFF22C55E).withOpacity(0.15)
                  : const Color(0xFF272A3D),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(
              icon,
              size: 20,
              color: granted ? const Color(0xFF22C55E) : Colors.grey[400],
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Text(title,
                      style: const TextStyle(
                          fontWeight: FontWeight.w600, fontSize: 15)),
                  const SizedBox(width: 8),
                  if (granted)
                    const Icon(Icons.check_circle,
                        size: 16, color: Color(0xFF22C55E)),
                ]),
                if (description.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    description,
                    style: TextStyle(
                        color: Colors.grey[500], fontSize: 12, height: 1.4),
                  ),
                ],
                const SizedBox(height: 12),
                SizedBox(
                  height: 34,
                  child: OutlinedButton(
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      side: BorderSide(
                        color: granted
                            ? const Color(0xFF22C55E).withOpacity(0.4)
                            : const Color(0xFFEC4899),
                      ),
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(8)),
                    ),
                    onPressed: granted ? null : onTap,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          granted
                              ? 'Granted'
                              : opensSettings
                                  ? 'Open Settings'
                                  : 'Grant',
                          style: TextStyle(
                            fontSize: 13,
                            color: granted
                                ? const Color(0xFF22C55E)
                                : const Color(0xFFEC4899),
                          ),
                        ),
                        if (opensSettings && !granted) ...[
                          const SizedBox(width: 4),
                          const Icon(Icons.open_in_new,
                              size: 13, color: Color(0xFF6366F1)),
                        ],
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
