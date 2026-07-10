import 'dart:io';
import 'package:dio/dio.dart';
import 'package:path_provider/path_provider.dart';

class FileService {
  final String serverUrl;
  final String token;
  final Dio _dio = Dio();

  FileService({required this.serverUrl, this.token = ''});

  Options get _opts => Options(headers: {
        'ngrok-skip-browser-warning': '1',
        if (token.isNotEmpty) 'Authorization': 'Bearer $token',
      });

  Future<List<Map<String, dynamic>>> listServerFiles({String path = ''}) async {
    final r = await _dio.get(
      '$serverUrl/api/files',
      queryParameters: {'path': path},
      options: _opts,
    );
    return List<Map<String, dynamic>>.from(r.data['entries']);
  }

  Future<String> downloadToPhone(String remotePath, String filename,
      {void Function(int, int)? onProgress}) async {
    Directory? dir;
    try {
      dir = Directory('/storage/emulated/0/Download');
      if (!dir.existsSync()) dir = await getExternalStorageDirectory();
    } catch (_) {
      dir = await getExternalStorageDirectory();
    }
    final savePath = '${dir!.path}/$filename';
    await _dio.download(
      '$serverUrl/api/files/download',
      savePath,
      queryParameters: {'path': remotePath},
      options: _opts,
      onReceiveProgress: onProgress,
    );
    return savePath;
  }

  Future<void> uploadToServer(String filePath,
      {void Function(int, int)? onProgress}) async {
    final filename = filePath.split('/').last;
    final formData = FormData.fromMap({
      'files': await MultipartFile.fromFile(filePath, filename: filename),
    });
    await _dio.post(
      '$serverUrl/api/files/upload',
      data: formData,
      options: _opts,
      onSendProgress: onProgress,
    );
  }
}
