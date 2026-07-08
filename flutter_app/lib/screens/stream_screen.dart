import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import '../services/screen_stream_service.dart';

class StreamScreen extends StatefulWidget {
  final ScreenStreamService streamService;
  final VoidCallback? onStopped;

  const StreamScreen({super.key, required this.streamService, this.onStopped});

  @override
  State<StreamScreen> createState() => _StreamScreenState();
}

class _StreamScreenState extends State<StreamScreen> {
  final RTCVideoRenderer _renderer = RTCVideoRenderer();
  bool _rendererReady = false;

  @override
  void initState() {
    super.initState();
    _initRenderer();
  }

  Future<void> _initRenderer() async {
    await _renderer.initialize();
    _renderer.srcObject = widget.streamService.localStream;
    setState(() => _rendererReady = true);
  }

  @override
  void dispose() {
    _renderer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: const Text('Live Preview'),
        actions: [
          TextButton.icon(
            onPressed: () async {
              widget.onStopped?.call();
              await widget.streamService.stop();
              if (context.mounted) Navigator.pop(context);
            },
            icon: const Icon(Icons.stop_circle, color: Color(0xFFEF4444)),
            label: const Text('Stop', style: TextStyle(color: Color(0xFFEF4444))),
          ),
        ],
      ),
      body: _rendererReady
          ? RTCVideoView(_renderer, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain)
          : const Center(child: CircularProgressIndicator()),
    );
  }
}
