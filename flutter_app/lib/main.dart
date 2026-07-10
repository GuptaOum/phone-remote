import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'screens/setup_screen.dart';
import 'services/auth_service.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  final setupDone = prefs.getBool('setup_done') ?? false;

  // Returning user with a saved login goes straight to the control screen
  Widget home;
  if (!setupDone) {
    home = const SetupScreen();
  } else {
    final session = await AuthService.savedSession();
    if (session != null) {
      final deviceId = await AuthService.deviceId();
      home = HomeScreen(
        serverUrl: session['serverUrl']!,
        token: session['token']!,
        deviceId: deviceId,
      );
    } else {
      home = const LoginScreen();
    }
  }
  runApp(PlusUApp(home: home));
}

class PlusUApp extends StatelessWidget {
  final Widget home;
  const PlusUApp({super.key, required this.home});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'plusU',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFFEC4899),
          brightness: Brightness.dark,
        ),
        scaffoldBackgroundColor: const Color(0xFF0D0F14),
        useMaterial3: true,
      ),
      home: home,
    );
  }
}
