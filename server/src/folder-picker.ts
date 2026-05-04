import { execFile } from 'node:child_process';

export interface PickFolderOptions {
  initialPath?: string;
}

export interface PickFileOptions {
  initialPath?: string;
}

const PICKER_TIMEOUT_MS = 300_000;

export async function pickFolder(opts: PickFolderOptions = {}): Promise<string | null> {
  const initial = opts.initialPath ?? '';
  if (process.platform === 'win32') return runWindowsFolderPicker(initial);
  if (process.platform === 'darwin') return runMacFolderPicker(initial);
  return runLinuxFolderPicker(initial);
}

export async function pickFile(opts: PickFileOptions = {}): Promise<string | null> {
  const initial = opts.initialPath ?? '';
  if (process.platform === 'win32') return runWindowsFilePicker(initial);
  if (process.platform === 'darwin') return runMacFilePicker(initial);
  return runLinuxFilePicker(initial);
}

function runWindowsFolderPicker(initialPath: string): Promise<string | null> {
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

  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        env: {
          ...process.env,
          FIRESIDE_FOLDER_PICKER_INITIAL: initialPath,
        },
        timeout: PICKER_TIMEOUT_MS,
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

function runWindowsFilePicker(initialPath: string): Promise<string | null> {
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

  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        env: {
          ...process.env,
          FIRESIDE_FILE_PICKER_INITIAL: initialPath,
        },
        timeout: PICKER_TIMEOUT_MS,
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

function runMacFolderPicker(initialPath: string): Promise<string | null> {
  const script = `
set initialPath to ""
try
  set initialPath to system attribute "FIRESIDE_FOLDER_PICKER_INITIAL"
end try
set defaultLoc to missing value
if initialPath is not "" then
  try
    set defaultLoc to (POSIX file initialPath) as alias
  end try
end if
try
  if defaultLoc is missing value then
    set chosen to choose folder with prompt "Choose a folder for Fireside"
  else
    set chosen to choose folder with prompt "Choose a folder for Fireside" default location defaultLoc
  end if
  POSIX path of chosen
on error number -128
  ""
end try
`;

  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-e', script],
      {
        env: {
          ...process.env,
          FIRESIDE_FOLDER_PICKER_INITIAL: initialPath,
        },
        timeout: PICKER_TIMEOUT_MS,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
          return;
        }
        const selected = stdout.trim();
        resolve(selected.length > 0 ? selected : null);
      },
    );
  });
}

function runMacFilePicker(initialPath: string): Promise<string | null> {
  const script = `
set initialPath to ""
try
  set initialPath to system attribute "FIRESIDE_FILE_PICKER_INITIAL"
end try
set defaultLoc to missing value
if initialPath is not "" then
  try
    set defaultLoc to (POSIX file initialPath) as alias
  end try
end if
try
  if defaultLoc is missing value then
    set chosen to choose file with prompt "Choose a file for Fireside"
  else
    set chosen to choose file with prompt "Choose a file for Fireside" default location defaultLoc
  end if
  POSIX path of chosen
on error number -128
  ""
end try
`;

  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-e', script],
      {
        env: {
          ...process.env,
          FIRESIDE_FILE_PICKER_INITIAL: initialPath,
        },
        timeout: PICKER_TIMEOUT_MS,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
          return;
        }
        const selected = stdout.trim();
        resolve(selected.length > 0 ? selected : null);
      },
    );
  });
}

interface LinuxPickerCandidate {
  command: string;
  args: string[];
}

function runLinuxFolderPicker(initialPath: string): Promise<string | null> {
  const candidates: LinuxPickerCandidate[] = [
    {
      command: 'zenity',
      args: [
        '--file-selection',
        '--directory',
        '--title=Choose a folder for Fireside',
        ...(initialPath ? [`--filename=${initialPath.replace(/\/?$/, '/')}`] : []),
      ],
    },
    {
      command: 'kdialog',
      args: [
        '--title',
        'Choose a folder for Fireside',
        '--getexistingdirectory',
        initialPath || '.',
      ],
    },
  ];
  return runLinuxPickerCandidates(candidates);
}

function runLinuxFilePicker(initialPath: string): Promise<string | null> {
  const candidates: LinuxPickerCandidate[] = [
    {
      command: 'zenity',
      args: [
        '--file-selection',
        '--title=Choose a file for Fireside',
        ...(initialPath ? [`--filename=${initialPath}`] : []),
      ],
    },
    {
      command: 'kdialog',
      args: ['--title', 'Choose a file for Fireside', '--getopenfilename', initialPath || '.'],
    },
  ];
  return runLinuxPickerCandidates(candidates);
}

async function runLinuxPickerCandidates(
  candidates: LinuxPickerCandidate[],
): Promise<string | null> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return await runLinuxPickerCommand(candidate);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isCommandNotFoundError(message)) {
        errors.push(`${candidate.command}: not installed`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `no supported file picker found on this system (tried: ${candidates.map((c) => c.command).join(', ')}). Install zenity or kdialog. Details: ${errors.join('; ')}`,
  );
}

function runLinuxPickerCommand(candidate: LinuxPickerCandidate): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      candidate.command,
      candidate.args,
      { timeout: PICKER_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            reject(new Error(`${candidate.command} not found`));
            return;
          }
          // zenity/kdialog return non-zero when the user cancels the dialog,
          // typically with empty stderr. Treat that as a clean cancel.
          const stderrTrim = stderr.trim();
          if (!stderrTrim) {
            resolve(null);
            return;
          }
          reject(new Error(stderrTrim));
          return;
        }
        const selected = stdout.trim();
        resolve(selected.length > 0 ? selected : null);
      },
    );
  });
}

function isCommandNotFoundError(message: string): boolean {
  return /not found|ENOENT/i.test(message);
}
