import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:permission_handler/permission_handler.dart';
import 'signaling_service.dart';

class PhoneFilesService {
  final SignalingService signaling;
  final Map<String, List<int>> _uploads = {};
  final Map<String, String> _uploadPaths = {};
  // Pending ack completers keyed by "$id_$index"
  final Map<String, Completer<void>> _chunkAcks = {};

  PhoneFilesService({required this.signaling});

  Future<bool> ensurePermission() async {
    if (!Platform.isAndroid) return true;
    if (await Permission.manageExternalStorage.isGranted) return true;
    final status = await Permission.manageExternalStorage.request();
    return status.isGranted;
  }

  Future<void> handle(Map<String, dynamic> msg) async {
    switch (msg['type']) {
      case 'pf_list':
        await _list(msg);
        break;
      case 'pf_download':
        await _download(msg);
        break;
      case 'pf_delete':
        await _delete(msg);
        break;
      case 'pf_upload_start':
        _uploads[msg['id'] as String] = [];
        _uploadPaths[msg['id'] as String] = msg['path'] as String;
        break;
      case 'pf_upload_chunk':
        await _uploadChunk(msg);
        break;
      case 'pf_chunk_ack':
        // Server confirmed it relayed the chunk — unblock the next send
        final key = '${msg['id']}_${msg['index']}';
        _chunkAcks.remove(key)?.complete();
        break;
    }
  }

  Future<void> _list(Map<String, dynamic> msg) async {
    final id = msg['id'] as String;
    final path = (msg['path'] as String?)?.isNotEmpty == true
        ? msg['path'] as String
        : '/storage/emulated/0';

    if (!await ensurePermission()) {
      signaling.send({'type': 'pf_error', 'id': id, 'error': 'Storage permission denied. Grant "All files access" in phone settings.'});
      return;
    }

    try {
      final dir = Directory(path);
      if (!dir.existsSync()) {
        signaling.send({'type': 'pf_error', 'id': id, 'error': 'Directory not found: $path'});
        return;
      }

      final entries = <Map<String, dynamic>>[];
      for (final e in dir.listSync(followLinks: false)) {
        try {
          final stat = e.statSync();
          entries.add({
            'name': e.path.split('/').last,
            'path': e.path,
            'type': e is Directory ? 'dir' : 'file',
            'size': stat.size,
            'modified': stat.modified.millisecondsSinceEpoch,
          });
        } catch (_) {}
      }

      entries.sort((a, b) {
        if (a['type'] != b['type']) return a['type'] == 'dir' ? -1 : 1;
        return (a['name'] as String).toLowerCase().compareTo((b['name'] as String).toLowerCase());
      });

      signaling.send({'type': 'pf_list_result', 'id': id, 'path': path, 'entries': entries});
    } catch (e) {
      signaling.send({'type': 'pf_error', 'id': id, 'error': e.toString()});
    }
  }

  Future<void> _download(Map<String, dynamic> msg) async {
    final id = msg['id'] as String;
    final path = msg['path'] as String;
    try {
      final file = File(path);
      if (!file.existsSync()) {
        signaling.send({'type': 'pf_error', 'id': id, 'error': 'File not found'});
        return;
      }

      final bytes = await file.readAsBytes();
      const chunkSize = 65536; // 64 KB

      if (bytes.isEmpty) {
        signaling.send({'type': 'pf_chunk', 'id': id, 'index': 0, 'total': 1, 'done': true, 'data': ''});
        return;
      }

      int offset = 0, index = 0;
      final total = (bytes.length / chunkSize).ceil();
      while (offset < bytes.length) {
        final end = (offset + chunkSize).clamp(0, bytes.length);
        final ackKey = '${id}_$index';
        final completer = Completer<void>();
        _chunkAcks[ackKey] = completer;

        signaling.send({
          'type': 'pf_chunk',
          'id': id,
          'index': index,
          'total': total,
          'done': end >= bytes.length,
          'data': base64.encode(bytes.sublist(offset, end)),
        });

        // Wait for server ack before sending next chunk — prevents WebSocket flood
        await completer.future;

        offset = end;
        index++;
      }
    } catch (e) {
      signaling.send({'type': 'pf_error', 'id': id, 'error': e.toString()});
    }
  }

  Future<void> _uploadChunk(Map<String, dynamic> msg) async {
    final id = msg['id'] as String;
    final data = base64.decode(msg['data'] as String);
    _uploads.putIfAbsent(id, () => []).addAll(data);

    if (msg['done'] == true) {
      final bytes = _uploads.remove(id) ?? [];
      final path = _uploadPaths.remove(id) ?? '';
      if (path.isEmpty) {
        signaling.send({'type': 'pf_error', 'id': id, 'error': 'Upload path missing'});
        return;
      }
      try {
        final file = File(path);
        await file.parent.create(recursive: true);
        await file.writeAsBytes(bytes);
        signaling.send({'type': 'pf_upload_ok', 'id': id, 'path': path});
      } catch (e) {
        signaling.send({'type': 'pf_error', 'id': id, 'error': e.toString()});
      }
    }
  }

  Future<void> _delete(Map<String, dynamic> msg) async {
    final id = msg['id'] as String;
    final path = msg['path'] as String;
    try {
      final type = FileSystemEntity.typeSync(path);
      if (type == FileSystemEntityType.directory) {
        await Directory(path).delete(recursive: true);
      } else if (type == FileSystemEntityType.file) {
        await File(path).delete();
      }
      signaling.send({'type': 'pf_delete_ok', 'id': id, 'path': path});
    } catch (e) {
      signaling.send({'type': 'pf_error', 'id': id, 'error': e.toString()});
    }
  }
}
