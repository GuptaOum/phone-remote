import 'dart:math';
import 'package:dio/dio.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// REST client for the account API (/api/login, /api/register).
/// The JWT it returns is what the Kotlin WebSocket authenticates with.
class AuthService {
  static final Dio _dio = Dio(BaseOptions(
    headers: {'ngrok-skip-browser-warning': '1'},
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 10),
  ));

  /// Returns the JWT. Throws with a readable message on failure.
  static Future<String> login(String serverUrl, String email, String password) =>
      _post(serverUrl, '/api/login', email, password);

  static Future<String> register(String serverUrl, String email, String password) =>
      _post(serverUrl, '/api/register', email, password);

  static Future<String> _post(
      String serverUrl, String path, String email, String password) async {
    try {
      final r = await _dio.post(
        '$serverUrl$path',
        data: {'email': email, 'password': password},
      );
      return r.data['token'] as String;
    } on DioException catch (e) {
      final msg = e.response?.data is Map ? e.response?.data['error'] : null;
      throw Exception(msg ?? 'Could not reach server');
    }
  }

  /// Stable per-install device id — generated once, reused forever.
  static Future<String> deviceId() async {
    final prefs = await SharedPreferences.getInstance();
    var id = prefs.getString('device_id');
    if (id == null) {
      final rnd = Random.secure();
      id = List.generate(32, (_) => rnd.nextInt(16).toRadixString(16)).join();
      await prefs.setString('device_id', id);
    }
    return id;
  }

  static Future<void> saveSession(
      {required String serverUrl, required String token, required String email}) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('server_url', serverUrl);
    await prefs.setString('jwt', token);
    await prefs.setString('email', email);
  }

  static Future<Map<String, String>?> savedSession() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('jwt');
    final url = prefs.getString('server_url');
    if (token == null || url == null) return null;
    return {
      'token': token,
      'serverUrl': url,
      'email': prefs.getString('email') ?? '',
    };
  }

  static Future<void> logout() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('jwt');
  }
}
