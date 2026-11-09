'use strict';
// The screen that shows when a working copy is open but no `svn` command line was found. It shows once per
// window (never a toast loop), lists the install command for this OS, and has Retry and "Set the svn path".
const { page } = require('./html');

const STEPS = {
  darwin: [
    ['Homebrew', 'brew install subversion', 'Installs svn to /opt/homebrew/bin (Apple silicon) or /usr/local/bin.'],
    ['MacPorts', 'sudo port install subversion', ''],
  ],
  linux: [
    ['Debian, Ubuntu', 'sudo apt install subversion', ''],
    ['Fedora, RHEL', 'sudo dnf install subversion', ''],
    ['Arch', 'sudo pacman -S subversion', ''],
    ['openSUSE', 'sudo zypper install subversion', ''],
  ],
  win32: [
    ['TortoiseSVN', '', 'Run the TortoiseSVN installer again, choose Modify and turn on "command line client tools". svn.exe goes to C:\\Program Files\\TortoiseSVN\\bin.'],
    ['SlikSVN', '', 'Install the free SlikSVN command line client. svn.exe goes to C:\\Program Files\\SlikSvn\\bin.'],
    ['winget', 'winget install -e --id Slik.Subversion', ''],
    ['Scoop', 'scoop install sliksvn', ''],
  ],
};

let current = null;

function showInstall({ vscode, context, support, settings, configured, reason }) {
  if (current) { current.reveal(); return current; }
  const panel = vscode.window.createWebviewPanel('zovoSvn.install', 'SVN: install the svn command line', vscode.ViewColumn.Active, {
    enableScripts: true, enableCommandUris: support.commandUris('zovoSvn'),
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
  current = panel;
  panel.onDidDispose(() => { current = null; });
  const os = STEPS[process.platform] ? process.platform : 'linux';
  panel.webview.html = page({ vscode, context, webview: panel.webview, script: 'install.js', css: 'install.css', title: 'Install svn', support, settings,
    data: { os, steps: STEPS[os], configured: configured || '', reason: reason || '' } });
  panel.webview.onDidReceiveMessage(async m => {
    if (m.type === 'copy') { await vscode.env.clipboard.writeText(m.text); vscode.window.setStatusBarMessage('Copied: ' + m.text, 3000); }
    else if (m.type === 'terminal') { const t = vscode.window.createTerminal('Install svn'); t.show(); t.sendText(m.text, false); }
    else if (m.type === 'retry') { await vscode.commands.executeCommand('zovoSvn.rescan'); }
    else if (m.type === 'setPath') { await vscode.commands.executeCommand('workbench.action.openSettings', 'zovoSvn.path'); }
  });
  return panel;
}

function closeInstall() { if (current) current.dispose(); }

module.exports = { showInstall, closeInstall, STEPS };
