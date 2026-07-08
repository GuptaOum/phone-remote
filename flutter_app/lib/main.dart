import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'screens/connect_screen.dart';
import 'screens/setup_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  final setupDone = prefs.getBool('setup_done') ?? false;
  runApp(PlusUApp(setupDone: setupDone));
}

class PlusUApp extends StatelessWidget {
  final bool setupDone;
  const PlusUApp({super.key, required this.setupDone});
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
      home: setupDone ? const ConnectScreen() : const SetupScreen(),
    );
  }
}
