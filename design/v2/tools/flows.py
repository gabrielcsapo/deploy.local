# One source of truth for the canvas: each flow is a page, each row is a step,
# and each step lists its boards per platform. The coverage board and the layout both read this.
# Platforms: web (the app in a browser or the desktop window), phone, app (desktop shell scenes), cli.
# An empty platform is marked in `gaps`: 'design' (deliberately not there), 'later', or omitted for not applicable.
FLOWS = [
    ('overview', 'Overview', [
        ('Design system', dict(web=['DesignSystem', 'States'])),
        ('Structure and coverage', dict(web=['Structure', 'Flow', 'Coverage'])),
    ]),
    ('start', '1 · Get started', [
        ('Install on SER', dict(web=['FirstAccount', 'PasskeyOffer'], cli=['InstallSer'], gaps=dict(phone='design'))),
        ('Recover SER from a backup', dict(web=['RecoverWeb'], gaps=dict(phone='design'))),
        ('Sign in', dict(phone=['SignInPhone'], app=['SignIn'], cli=['CliLogin'])),
        ('This computer joins', dict(app=['Setup', 'SetupLinux', 'Permissions'], gaps=dict(phone='design'))),
        ('A new install', dict(web=['Welcome'], gaps=dict(phone='later'))),
        ('A first project', dict(web=['NewProject', 'OneAppProject', 'FirstTask'], gaps=dict(phone='later'))),
        ('An app from Discover', dict(web=['Discover', 'InstallApp', 'ImmichApp', 'UpdateApp'], gaps=dict(phone='later'))),
    ]),
    ('work', '2 · Ask and build', [
        ('Start something', dict(web=['Home'], phone=['HomePhone', 'ComposePhone', 'AttachPhone', 'AttachedPhone', 'ModelPhone'])),
        ('A task runs', dict(web=['Task', 'TaskChanges', 'TaskChecks'], phone=['TaskPhone', 'ChangesPhone'])),
        ('A new product', dict(web=['NewProduct'], phone=['NewProductPhone', 'TaskInfoPhone'])),
        ('Screenshots and markup', dict(web=['MarkupDesktop'], phone=['PreviewPhone', 'MarkupPhone', 'MarkupTextPhone', 'MarkupSentPhone'])),
        ('A question', dict(phone=['AskPhone'], gaps=dict(web='later'))),
        ('Waiting on you', dict(web=['Inbox'], phone=['AnsweredPhone'])),
        ('When work goes wrong', dict(web=['TaskStalled', 'TaskFailed'], phone=['OfflinePhone'], app=['Offline'])),
        ('Using the screen', dict(web=['ScreenAsk'], app=['ScreenWatch'], gaps=dict(phone='design'))),
        ('Search', dict(web=['CommandPalette'], gaps=dict(phone='later'))),
    ]),
    ('ship', '3 · Review and ship', [
        ('A pull request', dict(web=['PullRequests', 'Review'], phone=['ReviewPhone'])),
        ('Ship', dict(web=['ShipDialog'], phone=['ShipPhone'], cli=['CliDeploy'])),
        ('A release runs', dict(web=['ReleaseLive'], phone=['ReleasePhone'])),
        ('A release fails', dict(web=['ReleaseFailed'], phone=['ReleaseFailedPhone'])),
        ('Every release', dict(web=['Deployments'], phone=['ReleasesPhone'])),
    ]),
    ('live', '4 · Live and incidents', [
        ('What is running', dict(web=['Live', 'LiveDark'], phone=['LivePhone'], app=['Tray'], cli=['CliStatus'])),
        ('A failure reaches you', dict(phone=['LockScreen'], app=['Notification'])),
        ('A sick worker', dict(web=['Worker'], phone=['WorkerPhone'])),
        ('Decide', dict(web=['Warden', 'Rollback'], phone=['Phone'])),
        ('The rollback runs', dict(web=['RollingBack'], phone=['RollbackPhone'])),
        ('Warden reports', dict(web=['WardenReport'], gaps=dict(phone='later'))),
        ('Rolled back by rule', dict(web=['AutoRollback'], gaps=dict(phone='later'))),
    ]),
    ('projects', '5 · Projects and apps', [
        ('All projects', dict(web=['Projects'], phone=['ProjectPhone'])),
        ('A project', dict(web=['Project', 'Code', 'Issues'], gaps=dict(phone='later'))),
        ('Its apps', dict(web=['App', 'AppSettings'], gaps=dict(phone='later'))),
        ('Logs', dict(web=['Logs'], gaps=dict(phone='later'))),
        ('Settings and secrets', dict(web=['ProjectSettings', 'SecretEdit'], gaps=dict(phone='design'))),
    ]),
    ('compute', '6 · Computers', [
        ('Computers', dict(web=['Compute', 'Computer'], phone=['ComputePhone'])),
        ('Models and limits', dict(web=['Models'], gaps=dict(phone='later'))),
        ('Add a computer', dict(web=['AddComputer'], gaps=dict(phone='design'))),
        ('Updates', dict(web=['SelfUpdate'], gaps=dict(phone='later'))),
        ('Remove a computer', dict(web=['RemoveComputer'], gaps=dict(phone='design'))),
    ]),
    ('agents', '7 · Agents and trust', [
        ('An agent', dict(web=['Main', 'LongChat'], phone=['ScoutPhone', 'AgentInfoPhone', 'AgentMenuPhone'])),
        ('Tune an agent', dict(web=['Configure', 'TuneWarden'], gaps=dict(phone='later'))),
        ('A new agent', dict(web=['NewAgent', 'NewAgentDraft', 'KeeperPage'], gaps=dict(phone='later'))),
        ('Approvals', dict(web=['SettingsAgents', 'RuleEdit', 'SettingsAgentsNew'], gaps=dict(phone='later'))),
    ]),
    ('settings', '8 · Settings and backups', [
        ('Settings', dict(web=['Settings'], phone=['SettingsPhone'])),
        ('Backups and restore', dict(web=['Backups', 'RestoreData'], phone=['RestorePhone'])),
    ]),
    ('public', '9 · Public site and docs', [
        ('The main page', dict(web=['Landing'], phone=['LandingPhone'])),
        ('Apps at home', dict(web=['AppsHome'], phone=['AppsHomePhone'])),
        ('Docs', dict(web=['DocsHome', 'DocsArticle'], phone=['DocsPhone'])),
        ('Changelog', dict(web=['Changelog'], gaps=dict(phone='later'))),
        ('Sign in on the web', dict(web=['WebSignIn', 'SessionExpired'], gaps=dict(phone='design'))),
        ('Wrong address, or down', dict(web=['AppNotFound', 'AppUnavailable', 'Restarting'], gaps=dict(phone='later'))),
    ]),
    ('cli', 'CLI', [
        ('Rules and help', dict(cli=['CliRules', 'CliHelp'])),
        ('Errors and scripting', dict(cli=['CliErrors'])),
    ]),
]
PLATFORMS = (('web', 'Web app'), ('phone', 'iPhone'), ('app', 'Desktop app'), ('cli', 'CLI'))
