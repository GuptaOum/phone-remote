import 'dart:async';
import 'package:geolocator/geolocator.dart';
import 'signaling_service.dart';

class LocationService {
  final SignalingService sig;
  StreamSubscription<Position>? _sub;

  LocationService({required this.sig});

  Future<void> start() async {
    // Permission already granted via setup_screen; just verify
    final perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) return;

    const settings = LocationSettings(
      accuracy: LocationAccuracy.high,
      distanceFilter: 10, // only update when moved ≥10 m
    );

    _sub = Geolocator.getPositionStream(locationSettings: settings).listen((pos) {
      sig.send({
        'type': 'location',
        'lat': pos.latitude,
        'lng': pos.longitude,
        'accuracy': pos.accuracy,
        'altitude': pos.altitude,
        'timestamp': pos.timestamp.millisecondsSinceEpoch,
      });
    });
  }

  void stop() {
    _sub?.cancel();
    _sub = null;
  }
}
