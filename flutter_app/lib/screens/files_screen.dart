import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:open_file/open_file.dart';
import 'package:permission_handler/permission_handler.dart';
import '../services/file_service.dart';

class FilesScreen extends StatefulWidget {
  final FileService fileService;
  const FilesScreen({super.key, required this.fileService});

  @override
  State<FilesScreen> createState() => _FilesScreenState();
}

class _FilesScreenState extends State<FilesScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabs;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0D0E17),
      appBar: AppBar(
        backgroundColor: const Color(0xFF161822),
        title: const Text('Files'),
        bottom: TabBar(
          controller: _tabs,
          indicatorColor: const Color(0xFFEC4899),
          tabs: const [
            Tab(text: 'PC Files'),
            Tab(text: 'Send to PC'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabs,
        children: [
          _PcFilesTab(fileService: widget.fileService),
          _SendToPcTab(fileService: widget.fileService),
        ],
      ),
    );
  }
}

// ── PC Files → Download to Phone ──────────────────────────────────────────

class _PcFilesTab extends StatefulWidget {
  final FileService fileService;
  const _PcFilesTab({required this.fileService});

  @override
  State<_PcFilesTab> createState() => _PcFilesTabState();
}

class _PcFilesTabState extends State<_PcFilesTab> {
  List<Map<String, dynamic>> _entries = [];
  String _currentPath = '';
  bool _loading = true;
  String? _error;
  final List<String> _breadcrumbs = [];

  @override
  void initState() {
    super.initState();
    _load('');
  }

  Future<void> _load(String path) async {
    setState(() { _loading = true; _error = null; });
    try {
      final entries = await widget.fileService.listServerFiles(path: path);
      setState(() { _entries = entries; _currentPath = path; _loading = false; });
    } catch (e) {
      setState(() { _error = e.toString(); _loading = false; });
    }
  }

  void _navigate(Map<String, dynamic> entry) {
    if (entry['type'] == 'dir') {
      _breadcrumbs.add(_currentPath);
      _load(entry['path'] as String);
    } else {
      _downloadFile(entry);
    }
  }

  void _goBack() {
    if (_breadcrumbs.isEmpty) return;
    _load(_breadcrumbs.removeLast());
  }

  Future<void> _downloadFile(Map<String, dynamic> entry) async {
    final name = entry['name'] as String;
    final remotePath = entry['path'] as String;

    await Permission.storage.request();

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Downloading $name...'), duration: const Duration(seconds: 60)),
    );
    try {
      final savedPath = await widget.fileService.downloadToPhone(
        remotePath, name,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).hideCurrentSnackBar();
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Saved to Downloads/$name'),
        action: SnackBarAction(
          label: 'Open',
          onPressed: () => OpenFile.open(savedPath),
        ),
      ));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).hideCurrentSnackBar();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Download failed: $e')),
      );
    }
  }

  String _formatSize(dynamic bytes) {
    if (bytes == null) return '';
    final b = (bytes as num).toInt();
    if (b < 1024) return '${b}B';
    if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(1)}KB';
    return '${(b / 1024 / 1024).toStringAsFixed(1)}MB';
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.error_outline, color: Colors.red, size: 48),
        const SizedBox(height: 12),
        Text(_error!, textAlign: TextAlign.center),
        const SizedBox(height: 12),
        ElevatedButton(onPressed: () => _load(_currentPath), child: const Text('Retry')),
      ]));
    }

    return Column(children: [
      // Breadcrumb bar
      if (_breadcrumbs.isNotEmpty)
        Container(
          color: const Color(0xFF161822),
          child: ListTile(
            leading: const Icon(Icons.arrow_back, color: Color(0xFF6366F1)),
            title: Text(
              _currentPath.isEmpty ? 'Root' : _currentPath,
              style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
              overflow: TextOverflow.ellipsis,
            ),
            onTap: _goBack,
          ),
        ),

      if (_entries.isEmpty)
        const Expanded(child: Center(child: Text('Folder is empty', style: TextStyle(color: Colors.grey))))
      else
        Expanded(
          child: ListView.builder(
            itemCount: _entries.length,
            itemBuilder: (ctx, i) {
              final e = _entries[i];
              final isDir = e['type'] == 'dir';
              return ListTile(
                leading: Icon(
                  isDir ? Icons.folder : _fileIcon(e['mime'] as String?),
                  color: isDir ? Colors.amber : const Color(0xFFEC4899),
                ),
                title: Text(e['name'] as String, overflow: TextOverflow.ellipsis),
                subtitle: isDir ? null : Text(_formatSize(e['size']),
                    style: const TextStyle(fontSize: 12, color: Colors.grey)),
                trailing: isDir
                    ? const Icon(Icons.chevron_right, color: Colors.grey)
                    : const Icon(Icons.download, color: Color(0xFF6366F1), size: 20),
                onTap: () => _navigate(e),
              );
            },
          ),
        ),
    ]);
  }

  IconData _fileIcon(String? mime) {
    if (mime == null) return Icons.insert_drive_file;
    if (mime.startsWith('image/')) return Icons.image;
    if (mime.startsWith('video/')) return Icons.video_file;
    if (mime.startsWith('audio/')) return Icons.audio_file;
    if (mime.contains('pdf')) return Icons.picture_as_pdf;
    if (mime.contains('zip') || mime.contains('archive')) return Icons.archive;
    return Icons.insert_drive_file;
  }
}

// ── Phone Files → Upload to PC ────────────────────────────────────────────

class _SendToPcTab extends StatefulWidget {
  final FileService fileService;
  const _SendToPcTab({required this.fileService});

  @override
  State<_SendToPcTab> createState() => _SendToPcTabState();
}

class _SendToPcTabState extends State<_SendToPcTab> {
  final List<_UploadTask> _tasks = [];

  Future<void> _pickAndUpload() async {
    final result = await FilePicker.platform.pickFiles(allowMultiple: true);
    if (result == null) return;

    for (final f in result.files) {
      if (f.path == null) continue;
      final task = _UploadTask(name: f.name, path: f.path!);
      setState(() => _tasks.insert(0, task));

      try {
        await widget.fileService.uploadToServer(
          f.path!,
          onProgress: (sent, total) {
            setState(() => task.progress = total > 0 ? sent / total : 0);
          },
        );
        setState(() => task.done = true);
      } catch (e) {
        setState(() { task.error = e.toString(); });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Padding(
        padding: const EdgeInsets.all(20),
        child: SizedBox(
          width: double.infinity,
          height: 52,
          child: ElevatedButton.icon(
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFFEC4899),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            icon: const Icon(Icons.upload_file),
            label: const Text('Pick Files to Send to PC', style: TextStyle(fontSize: 15)),
            onPressed: _pickAndUpload,
          ),
        ),
      ),
      const Padding(
        padding: EdgeInsets.symmetric(horizontal: 20),
        child: Text(
          'Files are saved in the plusU folder on your PC',
          style: TextStyle(color: Colors.grey, fontSize: 12),
          textAlign: TextAlign.center,
        ),
      ),
      const SizedBox(height: 16),
      if (_tasks.isEmpty)
        const Expanded(
          child: Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Icon(Icons.upload, size: 56, color: Colors.grey),
              SizedBox(height: 12),
              Text('No uploads yet', style: TextStyle(color: Colors.grey)),
            ]),
          ),
        )
      else
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            itemCount: _tasks.length,
            itemBuilder: (ctx, i) {
              final t = _tasks[i];
              return Card(
                color: const Color(0xFF161822),
                margin: const EdgeInsets.only(bottom: 10),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      const Icon(Icons.insert_drive_file, size: 18, color: Color(0xFF6366F1)),
                      const SizedBox(width: 8),
                      Expanded(child: Text(t.name, overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w500))),
                      if (t.done) const Icon(Icons.check_circle, color: Colors.green, size: 18)
                      else if (t.error != null) const Icon(Icons.error, color: Colors.red, size: 18),
                    ]),
                    if (!t.done && t.error == null) ...[
                      const SizedBox(height: 8),
                      LinearProgressIndicator(
                        value: t.progress,
                        backgroundColor: const Color(0xFF272A3D),
                        color: const Color(0xFFEC4899),
                      ),
                      const SizedBox(height: 4),
                      Text('${(t.progress * 100).toStringAsFixed(0)}%',
                          style: const TextStyle(fontSize: 12, color: Colors.grey)),
                    ],
                    if (t.error != null) ...[
                      const SizedBox(height: 6),
                      Text(t.error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
                    ],
                    if (t.done)
                      const Padding(
                        padding: EdgeInsets.only(top: 4),
                        child: Text('Uploaded to PC', style: TextStyle(color: Colors.green, fontSize: 12)),
                      ),
                  ]),
                ),
              );
            },
          ),
        ),
    ]);
  }
}

class _UploadTask {
  final String name;
  final String path;
  double progress = 0;
  bool done = false;
  String? error;
  _UploadTask({required this.name, required this.path});
}
