#!/usr/bin/env python3
# Writes package.json. Kept as a script so the command list, menus and settings stay consistent.
import json, os
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P = 'scmProvider == zovo-svn'
cmds = [
 ('zovoSvn.checkout', 'Checkout...', '$(cloud-download)'),
 ('zovoSvn.commit', 'Commit', '$(check)'),
 ('zovoSvn.commitSelected', 'Commit Selected Files', '$(check)'),
 ('zovoSvn.commitChangelist', 'Commit Changelist', '$(check)'),
 ('zovoSvn.refresh', 'Refresh', '$(refresh)'),
 ('zovoSvn.update', 'Update', '$(cloud-download)'),
 ('zovoSvn.updateToRevision', 'Update to Revision...', None),
 ('zovoSvn.cleanup', 'Cleanup', None),
 ('zovoSvn.add', 'Add', '$(add)'),
 ('zovoSvn.addAll', 'Add All Unversioned', '$(add)'),
 ('zovoSvn.revert', 'Revert (Discard Changes)', '$(discard)'),
 ('zovoSvn.revertAll', 'Revert All', '$(discard)'),
 ('zovoSvn.delete', 'Delete (svn delete)', '$(trash)'),
 ('zovoSvn.ignore', 'Add to svn:ignore', None),
 ('zovoSvn.resolve', 'Resolve Conflict...', '$(check)'),
 ('zovoSvn.openChange', 'Open Changes', '$(diff)'),
 ('zovoSvn.openFile', 'Open File', '$(go-to-file)'),
 ('zovoSvn.openBase', 'Open BASE Version', None),
 ('zovoSvn.addToChangelist', 'Move to Changelist...', None),
 ('zovoSvn.removeFromChangelist', 'Remove from Changelist', None),
 ('zovoSvn.showLog', 'Show Log (History)', '$(history)'),
 ('zovoSvn.showFileLog', 'Show File History', '$(history)'),
 ('zovoSvn.toggleBlame', 'Toggle Blame', '$(person)'),
 ('zovoSvn.openLineRevision', 'Open Changes of This Line\'s Revision', None),
 ('zovoSvn.openRevisionDiff', 'Open Changes of a Revision', None),
 ('zovoSvn.switch', 'Switch to Branch or Tag...', '$(git-branch)'),
 ('zovoSvn.createBranch', 'Create Branch...', None),
 ('zovoSvn.createTag', 'Create Tag...', None),
 ('zovoSvn.merge', 'Merge from Branch...', '$(git-merge)'),
 ('zovoSvn.revisionGraph', 'Show Revision Graph', '$(type-hierarchy)'),
 ('zovoSvn.shelve', 'Shelve Changes...', '$(archive)'),
 ('zovoSvn.unshelve', 'Unshelve...', None),
 ('zovoSvn.newChangelist', 'New Changelist...', '$(add)'),
 ('zovoSvn.moveToChangelist', 'Move to Changelist...', None),
 ('zovoSvn.rescan', 'Find Working Copies Again', None),
 ('zovoSvn.installHelp', 'Install the svn Command Line...', None),
 ('zovoSvn.showOutput', 'Show Output', None),
 ('zovoSvn.openWalkthrough', 'Get Started', None),
 ('zovoSvn.supportDeveloper', 'Support the developer', None),
 ('zovoSvn.moreViewers', 'More free tools by Zovo', None),
 ('zovoSvn.unlockWithSponsors', 'Unlock Zovo Pro with GitHub Sponsors', None),
 ('zovoSvn.enterLicenseKey', 'Enter Zovo license key', None),
 ('zovoSvn.getPro', 'Get Zovo Pro (USD 15 once, all Zovo tools)', None),
 ('zovoSvn.removeLicense', 'Remove Zovo license from this editor', None),
]
commands = []
for c, t, icon in cmds:
    d = {'command': c, 'title': t, 'category': 'SVN'}
    if icon: d['icon'] = icon
    commands.append(d)
resource_only = ['zovoSvn.commitSelected', 'zovoSvn.commitChangelist', 'zovoSvn.add', 'zovoSvn.addAll', 'zovoSvn.revert', 'zovoSvn.revertAll', 'zovoSvn.delete', 'zovoSvn.ignore', 'zovoSvn.resolve', 'zovoSvn.openChange', 'zovoSvn.openFile', 'zovoSvn.openBase', 'zovoSvn.addToChangelist', 'zovoSvn.removeFromChangelist', 'zovoSvn.openRevisionDiff', 'zovoSvn.moveToChangelist', 'zovoSvn.newChangelist']
palette = [{'command': c, 'when': 'false'} for c in resource_only]
palette += [{'command': c, 'when': 'zovoSvn.proEnabled'} for c in ['zovoSvn.unlockWithSponsors', 'zovoSvn.enterLicenseKey', 'zovoSvn.getPro', 'zovoSvn.removeLicense']]
palette += [{'command': 'zovoSvn.openLineRevision', 'when': 'zovoSvn.blameOn'}]
for c in ['zovoSvn.commit', 'zovoSvn.refresh', 'zovoSvn.update', 'zovoSvn.updateToRevision', 'zovoSvn.cleanup', 'zovoSvn.showLog', 'zovoSvn.switch', 'zovoSvn.createBranch', 'zovoSvn.createTag', 'zovoSvn.merge', 'zovoSvn.revisionGraph', 'zovoSvn.shelve', 'zovoSvn.unshelve']:
    palette.append({'command': c, 'when': 'zovoSvn.repoCount > 0'})
VERS = 'scmResourceState =~ /^(modified|added|deleted|missing|replaced|props|obstructed|incomplete)$/'
menus = {
 'commandPalette': palette,
 'scm/title': [
  {'command': 'zovoSvn.commit', 'group': 'navigation@1', 'when': P},
  {'command': 'zovoSvn.update', 'group': 'navigation@2', 'when': P},
  {'command': 'zovoSvn.refresh', 'group': 'navigation@3', 'when': P},
  {'command': 'zovoSvn.showLog', 'group': 'navigation@4', 'when': P},
  {'command': 'zovoSvn.update', 'group': '1_sync@1', 'when': P},
  {'command': 'zovoSvn.updateToRevision', 'group': '1_sync@2', 'when': P},
  {'command': 'zovoSvn.cleanup', 'group': '1_sync@3', 'when': P},
  {'command': 'zovoSvn.switch', 'group': '2_branch@1', 'when': P},
  {'command': 'zovoSvn.createBranch', 'group': '2_branch@2', 'when': P},
  {'command': 'zovoSvn.createTag', 'group': '2_branch@3', 'when': P},
  {'command': 'zovoSvn.merge', 'group': '2_branch@4', 'when': P},
  {'command': 'zovoSvn.showLog', 'group': '3_history@1', 'when': P},
  {'command': 'zovoSvn.revisionGraph', 'group': '3_history@2', 'when': P},
  {'command': 'zovoSvn.shelve', 'group': '4_shelve@1', 'when': P},
  {'command': 'zovoSvn.unshelve', 'group': '4_shelve@2', 'when': P},
  {'command': 'zovoSvn.showOutput', 'group': '9_other@1', 'when': P},
 ],
 'scm/resourceGroup/context': [
  {'command': 'zovoSvn.commit', 'group': 'inline@1', 'when': P + ' && scmResourceGroup == changes'},
  {'command': 'zovoSvn.revertAll', 'group': 'inline@2', 'when': P + ' && scmResourceGroup == changes'},
  {'command': 'zovoSvn.addAll', 'group': 'inline@1', 'when': P + ' && scmResourceGroup == unversioned'},
  {'command': 'zovoSvn.commitChangelist', 'group': 'inline@1', 'when': P + ' && scmResourceGroup =~ /^cl:/'},
  {'command': 'zovoSvn.revertAll', 'group': 'inline@2', 'when': P + ' && scmResourceGroup =~ /^cl:/'},
  {'command': 'zovoSvn.commit', 'group': '1_commit', 'when': P + ' && scmResourceGroup == changes'},
  {'command': 'zovoSvn.commitChangelist', 'group': '1_commit', 'when': P + ' && scmResourceGroup =~ /^cl:/'},
  {'command': 'zovoSvn.revertAll', 'group': '2_modify', 'when': P + ' && scmResourceGroup != unversioned && scmResourceGroup != conflicts'},
  {'command': 'zovoSvn.addAll', 'group': '2_modify', 'when': P + ' && scmResourceGroup == unversioned'},
 ],
 'scm/resourceState/context': [
  {'command': 'zovoSvn.openFile', 'group': 'inline@1', 'when': P + " && scmResourceState != deleted && scmResourceState != missing"},
  {'command': 'zovoSvn.revert', 'group': 'inline@2', 'when': P + ' && ' + VERS},
  {'command': 'zovoSvn.add', 'group': 'inline@2', 'when': P + ' && scmResourceState == unversioned'},
  {'command': 'zovoSvn.resolve', 'group': 'inline@2', 'when': P + ' && scmResourceState == conflicted'},
  {'command': 'zovoSvn.openChange', 'group': '1_open@1', 'when': P},
  {'command': 'zovoSvn.openFile', 'group': '1_open@2', 'when': P + " && scmResourceState != deleted && scmResourceState != missing"},
  {'command': 'zovoSvn.openBase', 'group': '1_open@3', 'when': P + ' && ' + VERS + ' && scmResourceState != added'},
  {'command': 'zovoSvn.showFileLog', 'group': '1_open@4', 'when': P + ' && scmResourceState != unversioned && scmResourceState != added'},
  {'command': 'zovoSvn.commitSelected', 'group': '2_commit@1', 'when': P + ' && scmResourceState != conflicted'},
  {'command': 'zovoSvn.add', 'group': '3_modify@1', 'when': P + ' && scmResourceState == unversioned'},
  {'command': 'zovoSvn.ignore', 'group': '3_modify@2', 'when': P + ' && scmResourceState == unversioned'},
  {'command': 'zovoSvn.revert', 'group': '3_modify@3', 'when': P},
  {'command': 'zovoSvn.delete', 'group': '3_modify@4', 'when': P + " && scmResourceState =~ /^(modified|missing|props)$/"},
  {'command': 'zovoSvn.resolve', 'group': '3_modify@5', 'when': P + ' && scmResourceState == conflicted'},
  {'command': 'zovoSvn.addToChangelist', 'group': '4_changelist@1', 'when': P + ' && ' + VERS},
  {'command': 'zovoSvn.removeFromChangelist', 'group': '4_changelist@2', 'when': P + ' && ' + VERS},
  {'command': 'zovoSvn.shelve', 'group': '5_shelve@1', 'when': P + ' && ' + VERS},
 ],
 'editor/title/context': [
  {'command': 'zovoSvn.showFileLog', 'group': '7_svn@1', 'when': 'zovoSvn.repoCount > 0 && resourceScheme == file'},
  {'command': 'zovoSvn.toggleBlame', 'group': '7_svn@2', 'when': 'zovoSvn.repoCount > 0 && resourceScheme == file'},
 ],
 'editor/context': [
  {'command': 'zovoSvn.toggleBlame', 'group': '7_svn@1', 'when': 'zovoSvn.repoCount > 0 && resourceScheme == file'},
  {'command': 'zovoSvn.openLineRevision', 'group': '7_svn@2', 'when': 'zovoSvn.blameOn'},
 ],
 'explorer/context': [
  {'command': 'zovoSvn.showFileLog', 'group': '7_svn@1', 'when': 'zovoSvn.repoCount > 0'},
 ],
 'view/title': [
  {'command': 'zovoSvn.newChangelist', 'group': 'navigation@1', 'when': 'view == zovoSvn.changelists'},
  {'command': 'zovoSvn.refresh', 'group': 'navigation@2', 'when': 'view == zovoSvn.changelists'},
 ],
 'view/item/context': [
  {'command': 'zovoSvn.moveToChangelist', 'group': '1_move', 'when': 'view == zovoSvn.changelists && viewItem == clfile'},
 ],
}
settings = {
 'zovoSvn.path': {'type': 'string', 'default': '', 'scope': 'machine', 'markdownDescription': 'Full path of the `svn` command line, for example `/opt/homebrew/bin/svn` or `C:\\Program Files\\TortoiseSVN\\bin\\svn.exe`. Empty: look on PATH and in the usual install folders. When set, only this path is used.'},
 'zovoSvn.statusDelayMs': {'type': 'number', 'default': 1000, 'minimum': 100, 'maximum': 60000, 'description': 'Wait this long after the last file change before one svn status runs. Many changes during a build become one status run, and there is never more than one svn status per working copy at a time.'},
 'zovoSvn.statusDepth': {'type': 'string', 'enum': ['infinity', 'immediates', 'files', 'empty'], 'default': 'infinity', 'enumDescriptions': ['The whole working copy.', 'Files and folders at the top level only.', 'Files at the top level only.', 'Only the root folder itself.'], 'description': 'How deep svn status looks. Lower it for very large working copies that you only change near the top.'},
 'zovoSvn.exclude': {'type': 'array', 'items': {'type': 'string'}, 'default': ['**/node_modules/**', '**/.git/**', '**/build/**', '**/dist/**', '**/target/**', '**/out/**', '**/.gradle/**', '**/__pycache__/**'], 'description': 'Glob patterns. File changes here do not start svn status, unversioned files here are not listed, and the working copy search does not look inside them. Versioned changes in these folders still show at the next refresh.'},
 'zovoSvn.detectDepth': {'type': 'number', 'default': 3, 'minimum': 0, 'maximum': 8, 'description': 'How many folder levels below each workspace folder to look for nested working copies (folders with their own .svn). 0 looks only at the workspace folders and the folders above them.'},
 'zovoSvn.showUnversioned': {'type': 'boolean', 'default': True, 'description': 'List unversioned files in their own group.'},
 'zovoSvn.maxListedFiles': {'type': 'number', 'default': 5000, 'minimum': 100, 'maximum': 100000, 'description': 'Most files listed per group. The count in the Source Control view stays exact.'},
 'zovoSvn.maxDiffMB': {'type': 'number', 'default': 20, 'minimum': 1, 'maximum': 1024, 'description': 'Files larger than this open without a text diff, and the gutter diff is off for them.'},
 'zovoSvn.commandTimeoutSec': {'type': 'number', 'default': 120, 'minimum': 5, 'maximum': 3600, 'description': 'Local svn commands (add, revert, info, cat BASE) are stopped after this many seconds.'},
 'zovoSvn.networkTimeoutSec': {'type': 'number', 'default': 300, 'minimum': 5, 'maximum': 7200, 'description': 'Commands that talk to the server (update, commit, log, blame, switch, merge) are stopped after this many seconds, with a message, so a server that does not answer never hangs VS Code.'},
 'zovoSvn.statusTimeoutSec': {'type': 'number', 'default': 300, 'minimum': 5, 'maximum': 7200, 'description': 'svn status is stopped after this many seconds.'},
 'zovoSvn.blame.mode': {'type': 'string', 'enum': ['gutter', 'inline'], 'default': 'gutter', 'enumDescriptions': ['Revision, author and date before every line.', 'Revision, author and date after the line the cursor is on.'], 'description': 'How Toggle Blame shows who changed each line.'},
 'zovoSvn.blame.maxMB': {'type': 'number', 'default': 10, 'minimum': 1, 'maximum': 512, 'description': 'Blame runs on files up to this size.'},
 'zovoSvn.log.pageSize': {'type': 'number', 'default': 100, 'minimum': 10, 'maximum': 1000, 'description': 'Revisions per page in the log view. More load as you scroll.'},
 'zovoSvn.refreshOnFocus': {'type': 'boolean', 'default': True, 'description': 'Run one svn status when the VS Code window gets focus, to pick up changes made in a terminal or another tool.'},
 'zovoSvn.askForRating': {'type': 'boolean', 'default': True, 'description': 'Ask once for a Marketplace rating after the extension worked for you on 2 separate occasions. "Later" asks one more time after 7 days, "No thanks" never asks again. It never asks after an error. Nothing is sent anywhere.'},
 'zovoSvn.showSupportLinks': {'type': 'boolean', 'default': True, 'description': 'Show the small Rate, More free tools and Sponsor links at the bottom of the log view. Nothing is sent anywhere.'},
}
pkg = {
 'name': 'zovo-svn-client',
 'displayName': 'SVN Client & Subversion Source Control (Commit, Blame, Log, Diff)',
 'description': 'Free SVN client for VS Code that uses your own svn command line. Subversion source control with commit, update, diff, log, blame, branch, switch and merge, one svn status at a time, and nested working copies found once. No sign-in, no network of its own.',
 'version': '0.1.0',
 'publisher': 'zovo',
 'license': 'MIT',
 'icon': 'icon.png',
 'galleryBanner': {'color': '#1B1F2E', 'theme': 'dark'},
 'engines': {'vscode': '^1.90.0', 'node': '>=18'},
 'categories': ['SCM Providers', 'Other'],
 'keywords': ['svn', 'subversion', 'svn client', 'subversion client', 'tortoisesvn', 'svn blame', 'svn log', 'svn diff', 'svn commit', 'svn update', 'scm', 'source control', 'version control', 'branch', 'merge', 'changelist', 'shelve', 'revision graph', 'offline', 'free'],
 'main': './src/extension.js',
 'activationEvents': ['workspaceContains:.svn', 'workspaceContains:*/.svn', 'workspaceContains:*/*/.svn', 'onStartupFinished'],
 'capabilities': {'untrustedWorkspaces': {'supported': 'limited', 'description': 'svn runs only from the PATH or the user-level zovoSvn.path setting; a workspace cannot point it at another program.', 'restrictedConfigurations': ['zovoSvn.path']}, 'virtualWorkspaces': False},
 'contributes': {
  'commands': commands,
  'menus': menus,
  'views': {'scm': [{'id': 'zovoSvn.changelists', 'name': 'SVN Changelists', 'when': 'zovoSvn.repoCount > 0', 'visibility': 'collapsed'}]},
  'viewsWelcome': [
   {'view': 'scm', 'contents': 'This folder is an svn working copy, but the svn command line was not found.\n[Install svn](command:zovoSvn.installHelp)\n[Retry](command:zovoSvn.rescan)', 'when': 'zovoSvn.missing'},
   {'view': 'zovoSvn.changelists', 'contents': 'No changed files yet. Changelists group files so you can commit them apart.\n[New Changelist](command:zovoSvn.newChangelist)'},
  ],
  'configuration': {'title': 'SVN Client', 'properties': settings},
  'walkthroughs': [{
   'id': 'zovoSvn.start', 'title': 'Get started with SVN Client', 'description': 'Commit, update, history and blame for Subversion working copies, with your own svn command line.',
   'steps': [
    {'id': 'svn', 'title': 'Have the svn command line', 'description': 'SVN Client runs the svn you have installed. Type svn help in a terminal to check that it is there.\n[Install help](command:zovoSvn.installHelp)', 'media': {'markdown': 'walkthrough/install.md'}},
    {'id': 'changes', 'title': 'See and commit your changes', 'description': 'Open Source Control. Changes, Unversioned, Conflicts and each changelist have their own group. Type a message and press Ctrl+Enter to commit.\n[Open Source Control](command:workbench.view.scm)', 'media': {'image': 'images/changes.png', 'altText': 'The Source Control view with SVN changes, a changelist and a conflict.'}, 'completionEvents': ['onCommand:workbench.view.scm']},
    {'id': 'history', 'title': 'Read the history', 'description': 'Show Log lists revisions page by page, with filters for text, author and date, the changed paths and diffs.\n[Show Log](command:zovoSvn.showLog)', 'media': {'markdown': 'walkthrough/history.md'}, 'completionEvents': ['onCommand:zovoSvn.showLog']},
    {'id': 'blame', 'title': 'See who changed a line', 'description': 'Toggle Blame shows revision, author and date next to every line. Hover for the message and a link to the diff.\n[Toggle Blame](command:zovoSvn.toggleBlame)', 'media': {'markdown': 'walkthrough/blame.md'}, 'completionEvents': ['onCommand:zovoSvn.toggleBlame']},
   ]}],
 },
 'scripts': {
  'test': 'node --test test/*.test.js',
  'package': 'npx -y @vscode/vsce@3 package --no-dependencies -o dist/',
 },
 'devDependencies': {'@types/vscode': '~1.90.0'},
 'homepage': 'https://github.com/theluckystrike/svn-client-vscode#readme',
 'bugs': {'url': 'https://github.com/theluckystrike/svn-client-vscode/issues'},
 'repository': {'type': 'git', 'url': 'https://github.com/theluckystrike/svn-client-vscode'},
 'sponsor': {'url': 'https://github.com/sponsors/theluckystrike'},
}
open(os.path.join(root, 'package.json'), 'w').write(json.dumps(pkg, indent=2, ensure_ascii=False) + '\n')
print('package.json:', len(commands), 'commands')
