import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/auth_service.dart';
import 'home_screen.dart';

/// Production server — hardcode your domain here once deployed
/// (e.g. 'https://phoneremote.example.com'). While empty, the server
/// field is shown so any server can be used during development.
const String kDefaultServerUrl = 'https://3-6-239-48.sslip.io'; // AWS EC2 (ap-south-1), HTTPS via Let's Encrypt

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _server = TextEditingController(text: kDefaultServerUrl);
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _registerMode = false;
  bool _busy = false;
  String? _err;

  @override
  void initState() {
    super.initState();
    _loadSaved();
  }

  Future<void> _loadSaved() async {
    final prefs = await SharedPreferences.getInstance();
    final url = prefs.getString('server_url');
    final email = prefs.getString('email');
    if (mounted) {
      setState(() {
        if (kDefaultServerUrl.isEmpty && url != null) _server.text = url;
        if (email != null) _email.text = email;
      });
    }
  }

  @override
  void dispose() {
    _server.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final server = _server.text.trim().replaceAll(RegExp(r'/+$'), '');
    final email = _email.text.trim();
    final password = _password.text;

    if (!server.startsWith('http')) {
      setState(() => _err = 'Server URL must start with http:// or https://');
      return;
    }
    if (email.isEmpty || !email.contains('@')) {
      setState(() => _err = 'Enter a valid email');
      return;
    }
    if (password.length < 6) {
      setState(() => _err = 'Password must be at least 6 characters');
      return;
    }

    setState(() { _busy = true; _err = null; });
    try {
      final token = _registerMode
          ? await AuthService.register(server, email, password)
          : await AuthService.login(server, email, password);
      await AuthService.saveSession(serverUrl: server, token: token, email: email);
      final deviceId = await AuthService.deviceId();
      if (!mounted) return;
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (_) => HomeScreen(serverUrl: server, token: token, deviceId: deviceId),
        ),
      );
    } catch (e) {
      setState(() => _err = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  InputDecoration _dec(String label, String hint) => InputDecoration(
        labelText: label,
        hintText: hint,
        filled: true,
        fillColor: const Color(0xFF161822),
        border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFF272A3D))),
        focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFFEC4899), width: 1.5)),
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(28, 48, 28, 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
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
              Text(_registerMode ? 'Create account' : 'Welcome back',
                  style: const TextStyle(fontSize: 34, fontWeight: FontWeight.bold)),
              const SizedBox(height: 6),
              Text(
                  _registerMode
                      ? 'One account for all your devices'
                      : 'Sign in to link this phone to your account',
                  style: TextStyle(color: Colors.grey[500], fontSize: 14)),
              const SizedBox(height: 40),

              if (kDefaultServerUrl.isEmpty) ...[
                TextField(
                  controller: _server,
                  keyboardType: TextInputType.url,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 14),
                  decoration: _dec('Server URL', 'https://phoneremote.example.com'),
                ),
                const SizedBox(height: 14),
              ],
              TextField(
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                decoration: _dec('Email', 'you@example.com'),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: _password,
                obscureText: true,
                decoration: _dec('Password', 'min. 6 characters'),
                onSubmitted: (_) => _submit(),
              ),

              if (_err != null) ...[
                const SizedBox(height: 14),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: const Color(0x22EF4444),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: const Color(0x66EF4444)),
                  ),
                  child: Text(_err!,
                      style: const TextStyle(color: Color(0xFFFCA5A5), fontSize: 13)),
                ),
              ],

              const SizedBox(height: 22),
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
                  onPressed: _busy ? null : _submit,
                  child: _busy
                      ? const SizedBox(
                          width: 22,
                          height: 22,
                          child: CircularProgressIndicator(
                              strokeWidth: 2.5, color: Colors.white))
                      : Text(_registerMode ? 'Create account' : 'Sign in',
                          style: const TextStyle(
                              fontSize: 16, fontWeight: FontWeight.w600)),
                ),
              ),
              const SizedBox(height: 18),
              Center(
                child: TextButton(
                  onPressed: _busy
                      ? null
                      : () => setState(() {
                            _registerMode = !_registerMode;
                            _err = null;
                          }),
                  child: Text(
                    _registerMode
                        ? 'Already have an account?  Sign in'
                        : 'No account yet?  Create one',
                    style: TextStyle(color: Colors.grey[400], fontSize: 13.5),
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
