'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

/** Open a native directory chooser on the machine running Server. */
async function selectProjectDirectory({ platform = process.platform } = {}) {
  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('osascript', [
        '-e', 'POSIX path of (choose folder with prompt "选择项目文件夹")',
      ], { timeout: 120_000, maxBuffer: 1024 * 1024 });
      return { path: stdout.trim().replace(/\/$/, '') || '/' };
    } catch (error) {
      if (/(-128|User canceled|用户取消)/i.test(`${error.stderr || ''} ${error.message || ''}`)) return { cancelled: true };
      throw new Error(`无法打开系统文件夹选择器：${error.stderr?.trim() || error.message}`);
    }
  }

  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
      '$dialog.Description = "选择项目文件夹";',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) } else { exit 2 }',
    ].join(' ');
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
        timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      return { path: stdout.trim() };
    } catch (error) {
      if (error.code === 2) return { cancelled: true };
      throw new Error(`无法打开系统文件夹选择器：${error.stderr?.trim() || error.message}`);
    }
  }

  for (const command of ['zenity', 'kdialog']) {
    try {
      const args = command === 'zenity'
        ? ['--file-selection', '--directory', '--title=选择项目文件夹']
        : ['--getexistingdirectory', '.', '--title', '选择项目文件夹'];
      const { stdout } = await execFileAsync(command, args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
      return { path: stdout.trim() };
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code === 1 || error.code === 2) return { cancelled: true };
      throw new Error(`无法打开系统文件夹选择器：${error.stderr?.trim() || error.message}`);
    }
  }
  throw new Error('当前系统没有可用的图形文件夹选择器');
}

module.exports = { selectProjectDirectory };
