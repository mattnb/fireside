import { execFile } from 'node:child_process';

export interface PickFolderOptions {
  initialPath?: string;
}

export interface PickFileOptions {
  initialPath?: string;
}

export async function pickFolder(opts: PickFolderOptions = {}): Promise<string | null> {
  if (process.platform !== 'win32') {
    throw new Error('folder picker is only available on Windows');
  }

const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = 'CenterScreen'
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Width = 1
$owner.Height = 1
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a folder for Fireside'
$dialog.ShowNewFolderButton = $true
if ($env:FIRESIDE_FOLDER_PICKER_INITIAL -and (Test-Path -LiteralPath $env:FIRESIDE_FOLDER_PICKER_INITIAL)) {
  $dialog.SelectedPath = $env:FIRESIDE_FOLDER_PICKER_INITIAL
}
try {
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.SelectedPath
  }
} finally {
  $dialog.Dispose()
  $owner.Close()
  $owner.Dispose()
}
`;

  return await new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        env: {
          ...process.env,
          FIRESIDE_FOLDER_PICKER_INITIAL: opts.initialPath ?? '',
        },
        timeout: 300_000,
        windowsHide: false,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr.trim() || err.message;
          reject(new Error(detail));
          return;
        }
        const selected = stdout.trim();
        resolve(selected.length > 0 ? selected : null);
      },
    );
    child.stdin?.end();
  });
}

export async function pickFile(opts: PickFileOptions = {}): Promise<string | null> {
  if (process.platform !== 'win32') {
    throw new Error('file picker is only available on Windows');
  }

  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = 'CenterScreen'
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Width = 1
$owner.Height = 1
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Choose a file for Fireside'
$dialog.Filter = 'All files (*.*)|*.*'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true
if ($env:FIRESIDE_FILE_PICKER_INITIAL -and (Test-Path -LiteralPath $env:FIRESIDE_FILE_PICKER_INITIAL)) {
  if ((Get-Item -LiteralPath $env:FIRESIDE_FILE_PICKER_INITIAL).PSIsContainer) {
    $dialog.InitialDirectory = $env:FIRESIDE_FILE_PICKER_INITIAL
  } else {
    $dialog.InitialDirectory = Split-Path -Parent $env:FIRESIDE_FILE_PICKER_INITIAL
    $dialog.FileName = Split-Path -Leaf $env:FIRESIDE_FILE_PICKER_INITIAL
  }
}
try {
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.FileName
  }
} finally {
  $dialog.Dispose()
  $owner.Close()
  $owner.Dispose()
}
`;

  return await new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        env: {
          ...process.env,
          FIRESIDE_FILE_PICKER_INITIAL: opts.initialPath ?? '',
        },
        timeout: 300_000,
        windowsHide: false,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr.trim() || err.message;
          reject(new Error(detail));
          return;
        }
        const selected = stdout.trim();
        resolve(selected.length > 0 ? selected : null);
      },
    );
    child.stdin?.end();
  });
}
