import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'home_screen.dart';

class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key});
  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen>
    with SingleTickerProviderStateMixin {
  final _ctrl = TextEditingController(text: 'http://');
  String? _err;
  List<String> _recent = [];
  bool _showRecent = false;

  late AnimationController _fadeCtrl;
  late Animation<double> _fadeAnim;

  static const _prefsKey = 'recent_servers';
  static const _maxRecent = 8;
  static const _ch = MethodChannel('com.phoneremote/touch');

  @override
  void initState() {
    super.initState();
    _fadeCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 700),
    )..forward();
    _fadeAnim = CurvedAnimation(parent: _fadeCtrl, curve: Curves.easeOut);
    _loadRecent();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    _fadeCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadRecent() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() => _recent = prefs.getStringList(_prefsKey) ?? []);
  }

  Future<void> _saveUrl(String url) async {
    final prefs = await SharedPreferences.getInstance();
    final list = prefs.getStringList(_prefsKey) ?? [];
    list.remove(url);
    list.insert(0, url);
    if (list.length > _maxRecent) list.removeLast();
    await prefs.setStringList(_prefsKey, list);
    setState(() => _recent = list);
  }

  Future<void> _deleteRecent(String url) async {
    final prefs = await SharedPreferences.getInstance();
    final list = prefs.getStringList(_prefsKey) ?? [];
    list.remove(url);
    await prefs.setStringList(_prefsKey, list);
    setState(() => _recent = list);
    try {
      await _ch.invokeMethod('stopConnectionServiceForUrl', {'url': url});
    } catch (_) {}
  }

  void _connect(String url) {
    final trimmed = url.trim();
    if (!trimmed.startsWith('http')) {
      setState(() => _err = 'URL must start with http://');
      return;
    }
    setState(() => _err = null);
    _saveUrl(trimmed);
    Navigator.push(
      context,
      MaterialPageRoute(builder: (_) => HomeScreen(serverUrl: trimmed)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: FadeTransition(
          opacity: _fadeAnim,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(28, 48, 28, 32),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Logo / brand mark
                Container(
                  width: 52,
                  height: 52,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      colors: [Color(0xFFEC4899), Color(0xFFF9A8D4)],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                    borderRadius: BorderRadius.circular(16),
                  ),
                ),
                const SizedBox(height: 24),
                const Text('plusU',
                    style: TextStyle(fontSize: 34, fontWeight: FontWeight.bold)),
                const SizedBox(height: 6),
                Text('Enter your server address',
                    style: TextStyle(color: Colors.grey[500], fontSize: 14)),
                const SizedBox(height: 44),

                // URL input
                TextField(
                  controller: _ctrl,
                  keyboardType: TextInputType.url,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 14),
                  decoration: InputDecoration(
                    labelText: 'Server URL',
                    hintText: 'http://192.168.1.x:3000',
                    filled: true,
                    fillColor: const Color(0xFF161822),
                    border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide:
                            const BorderSide(color: Color(0xFF272A3D))),
                    focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide:
                            const BorderSide(color: Color(0xFFEC4899), width: 1.5)),
                    errorText: _err,
                  ),
                ),
                const SizedBox(height: 14),

                // Connect button
                SizedBox(
                  width: double.infinity,
                  height: 54,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFFEC4899),
                      foregroundColor: Colors.white,
                      elevation: 0,
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(14)),
                    ),
                    onPressed: () => _connect(_ctrl.text),
                    child: const Text('Connect',
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                  ),
                ),

                // Recent sessions
                if (_recent.isNotEmpty) ...[
                  const SizedBox(height: 36),
                  GestureDetector(
                    onTap: () => setState(() => _showRecent = !_showRecent),
                    child: Row(children: [
                      Text('Recent',
                          style: TextStyle(
                              color: Colors.grey[400],
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              letterSpacing: 0.4)),
                      const SizedBox(width: 4),
                      Icon(
                        _showRecent
                            ? Icons.keyboard_arrow_up
                            : Icons.keyboard_arrow_down,
                        color: Colors.grey[600],
                        size: 18,
                      ),
                    ]),
                  ),
                  AnimatedSize(
                    duration: const Duration(milliseconds: 250),
                    curve: Curves.easeInOut,
                    child: _showRecent
                        ? Column(
                            children: [
                              const SizedBox(height: 10),
                              ..._recent.map((url) => Container(
                                    margin: const EdgeInsets.only(bottom: 8),
                                    decoration: BoxDecoration(
                                      color: const Color(0xFF161822),
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(
                                          color: const Color(0xFF272A3D)),
                                    ),
                                    child: ListTile(
                                      dense: true,
                                      contentPadding:
                                          const EdgeInsets.symmetric(
                                              horizontal: 14, vertical: 2),
                                      title: Text(url,
                                          style: const TextStyle(
                                              fontFamily: 'monospace',
                                              fontSize: 12),
                                          overflow: TextOverflow.ellipsis),
                                      trailing: IconButton(
                                        icon: const Icon(Icons.close,
                                            size: 16, color: Colors.grey),
                                        onPressed: () => _deleteRecent(url),
                                      ),
                                      onTap: () => _connect(url),
                                    ),
                                  )),
                            ],
                          )
                        : const SizedBox.shrink(),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
