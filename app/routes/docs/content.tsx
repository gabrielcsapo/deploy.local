import type { ReactNode } from 'react';
import { Group } from '../../components/ui/v2/Group';
import { Setting } from '../../components/ui/v2/Setting';
import { Steps } from '../../components/ui/v2/Steps';
import { Term } from '../../components/ui/v2/Term';

export type DocSection = { id: string; title: string; toc?: string; body: ReactNode };
export type Doc = {
  slug: string;
  title: string;
  group: string;
  intro: string;
  sections: DocSection[];
};
const section = (id: string, title: string, body: ReactNode, toc?: string): DocSection => ({
  id,
  title,
  body,
  toc,
});
const command = (text: string) => <Term>{text}</Term>;
const docLink = (slug: string, text: string) => <a href={docPath(slug)}>{text}</a>;
export function docPath(slug: string) {
  return slug ? `/docs/${slug}` : '/docs';
}
export const groups = ['Start', 'Build', 'Run', 'Agents', 'Reference'];

export const docs: Doc[] = [
  {
    slug: '',
    title: 'Get started',
    group: 'Start',
    intro:
      'deploy.local runs on a computer at home that stays on. These docs call it SER; yours can have any name.',
    sections: [
      section(
        'install',
        'Install on the computer that stays on',
        <>
          <p>
            It needs Docker to run apps. Start with the source installation instructions, then
            install the CLI from your own coordinator.
          </p>
          <p>{docLink('install', 'Install on a computer →')}</p>
        </>,
        'Install',
      ),
      section(
        'finish-setup',
        'Make your first account',
        <>
          <p>
            Create an account with a username and password. The first account is the administrator.
            Sign in from another computer on the same home network.
          </p>
          <p>
            A passkey comes later, after certificate trust. Passkey setup is not available in this
            version; use your password.
          </p>
        </>,
        'Finish setup',
      ),
      section(
        'add-computers',
        'Add your other computers',
        <>
          <p>
            Open Computers, choose Add a computer, and follow the join instructions. Each computer
            reports what it can do. Unsupported roles cannot be turned on.
          </p>
          <p>{docLink('computers', 'Add a computer →')}</p>
        </>,
        'Add computers',
      ),
      section(
        'ask',
        'Ask for something',
        <>
          <p>
            Use the CLI to start work, or open Scout to ask a question. The Home composer and task
            pages are still being connected in this version. You start every release. Agents never
            ship.
          </p>
          <p>{docLink('ask', 'Ask and build →')}</p>
        </>,
        'Ask for something',
      ),
      section(
        'words',
        'Words you will see',
        <Group>
          <div className="dl-inset">
            {[
              [
                'Project',
                'A repository and the apps it runs. Releases, logs and secrets belong to it.',
              ],
              [
                'Task',
                'Work an agent does on one of your computers. A code change can lead to a pull request for you to review.',
              ],
              [
                'Release',
                'One version of a whole project, started by you and checked before it goes live.',
              ],
              [
                'Waiting on you',
                'Decisions that need your answer. The ! mark appears only on these decisions.',
              ],
              ['Live', 'Everything running right now, grouped by computer.'],
              [
                'Scout and Warden',
                'Scout helps with work. Warden watches running apps and can ask you to roll back. Agents never ship.',
              ],
              [
                'Ship…',
                'The action for starting a release yourself. The task-page action is not connected in this version.',
              ],
            ].map(([label, description]) => (
              <Setting key={label} label={label} description={description}>
                {null}
              </Setting>
            ))}
          </div>
        </Group>,
      ),
    ],
  },
  {
    slug: 'install',
    title: 'Install on a computer',
    group: 'Start',
    intro:
      'Choose a computer that can stay on and remain connected to your home network. It will be the coordinator.',
    sections: [
      section(
        'requirements',
        'Before you start',
        <p>
          You need Docker for apps, Git for repositories, and OpenSSL for local certificates. The
          source checkout also needs the JavaScript runtime and pnpm versions listed in its
          package.json. Keep the coordinator on the same network as your other devices.
        </p>,
      ),
      section(
        'coordinator',
        'Set up the coordinator',
        <>
          <p>
            This version uses the{' '}
            <a href="https://github.com/gabrielcsapo/deploy.local#readme">
              source installation instructions
            </a>
            . There is no one-command fresh-or-recover installer yet. Build and start the
            coordinator before installing a CLI on another computer.
          </p>
          {command(
            'git clone https://github.com/gabrielcsapo/deploy.local.git\ncd deploy.local\npnpm install --frozen-lockfile\npnpm build\npnpm start',
          )}
          <p>
            The coordinator keeps accounts, project history and local certificates. Choose a
            persistent data folder and keep a backup of it.
          </p>
        </>,
      ),
      section(
        'cli',
        'Install the CLI',
        <>
          <p>
            An existing coordinator serves the CLI installer at <a href="/install">/install</a> for
            macOS and Linux, and <a href="/install.ps1">/install.ps1</a> for Windows. These install
            the CLI, not the coordinator. Use your own coordinator’s address.
          </p>
          <p>
            The CLI saves its account settings in <code>~/.deployrc</code>. Password login is
            available with <code>deploy login</code>. Account creation remains in{' '}
            <code>deploy help advanced</code>.
          </p>
        </>,
      ),
      section(
        'trust',
        'Trust your home certificate',
        <>
          <p>
            Download <a href="/ca.crt">your coordinator’s CA certificate</a> and trust it on each
            device you use. On macOS, add it in Keychain Access and set its trust. On iPhone,
            install the profile, then enable full trust in Certificate Trust Settings.
          </p>
          <p>
            The first account uses a password. This version has no setup-code or passkey
            registration flow. {docLink('troubleshooting', 'Troubleshooting')} covers connection
            problems.
          </p>
        </>,
      ),
    ],
  },
  {
    slug: 'computers',
    title: 'Add a computer',
    group: 'Start',
    intro:
      'Computers shows which computers are connected, what they run, and which roles they support.',
    sections: [
      section(
        'join',
        'Join your home',
        <>
          <ol>
            <li>
              Sign in as the administrator and open{' '}
              <a href="/dashboard/computers/add">Add a computer</a>.
            </li>
            <li>Enter its name and create a join code. The code lasts ten minutes.</li>
            <li>
              On that computer, install the CLI and run the join command shown in the dialog. Enter
              the code when asked.
            </li>
            <li>
              Wait for the computer to appear as connected. Make another code if the first expires.
            </li>
          </ol>
          <p>
            The dialog supplies the coordinator address. Linux enrollment needs administrator
            privileges. On macOS, run enrollment from your usual desktop account.
          </p>
        </>,
      ),
      section(
        'roles',
        'Choose what it does',
        <>
          <ul>
            <li>
              <strong>Coordinator</strong> keeps shared state and stays on.
            </li>
            <li>
              <strong>Take tasks</strong> lets the computer accept agent work.
            </li>
            <li>
              <strong>Run apps</strong> shows that it hosts apps.
            </li>
            <li>
              <strong>Serve models</strong> shows its reported model-serving role.
            </li>
            <li>
              <strong>Use the screen</strong> lets supported screen tools accept work.
            </li>
          </ul>
          <p>
            Take tasks and Use the screen can be changed when the computer supports them. Run apps
            and Serve models are read-only here. Turning off Take tasks leaves existing work
            running.
          </p>
        </>,
      ),
      section(
        'remove',
        'Remove a computer',
        <p>
          Open the computer and choose Remove. It must have no assigned apps or unfinished work. The
          coordinator cannot be removed. Removal revokes access and leaves files on disk. Moving
          everything to another computer is not available here.
        </p>,
      ),
    ],
  },
  {
    slug: 'devices',
    title: 'Your devices',
    group: 'Start',
    intro:
      'Use your browser, the desktop shell, or iPhone on your home network. They connect to the same coordinator.',
    sections: [
      section(
        'browser',
        'In a browser',
        <p>
          Open deploy.local and sign in with your password. Use the same account to see the same
          projects and Waiting on you. Keep your coordinator’s certificate trusted on each device.
        </p>,
      ),
      section(
        'desktop',
        'On a desktop computer',
        <>
          <p>
            The Electron desktop shell loads the web app and adds a tray, notifications and a task
            worker. Its setup uses a password and asks you to verify the coordinator’s certificate
            fingerprint.
          </p>
          <p>
            Closing the window leaves the worker running. Quit stops it. Take tasks is supported;
            screen use requires the macOS helper and system permissions. Packaged downloads are not
            published yet, so Computers does not offer a working download button.
          </p>
        </>,
      ),
      section(
        'iphone',
        'On iPhone',
        <>
          <p>
            The iPhone app has Work, Projects, Live, Computers and Settings. You can read work and
            answer Waiting on you. Decisions are shared with the web and CLI.
          </p>
          <p>
            Only on your home network. When disconnected, saved information is not current health.
            QR pairing is not implemented in this version.
          </p>
        </>,
      ),
    ],
  },
  {
    slug: 'ask',
    title: 'Ask and build',
    group: 'Build',
    intro:
      'Say what you want changed and how you will know it works. Give the agent a small, clear starting point.',
    sections: [
      section(
        'start',
        'Start work',
        <>
          <p>
            The CLI’s <code>task</code> command starts work; <code>tasks</code> lists it. Use{' '}
            <code>--on</code> to select a computer and <code>--agent scout</code> for Scout. Other
            agent names are not supported by this CLI path yet. See {docLink('cli', 'CLI')} for the
            command syntax.
          </p>
          <p>
            The web Home composer and task routes in this version are placeholders. Use the CLI or
            iPhone’s task composer to start work.
          </p>
        </>,
      ),
      section(
        'questions',
        'Ask a question',
        <p>
          Open <a href="/dashboard/agents/scout">Scout</a> to ask about your work. Agent chat uses a
          configured compatible model provider. That chat can reply, but cannot run tools or change
          files. A provider connection is required.
        </p>,
      ),
      section(
        'decisions',
        'Answer Waiting on you',
        <>
          <p>
            Open <a href="/dashboard/inbox">Waiting on you</a> to review questions and permission
            requests. Read the action before choosing it. An answer from any device answers the same
            item everywhere.
          </p>
          <p>
            The first answer wins. Answered keeps who answered, when, and from which device. If
            another device answered first, refresh to read that result.
          </p>
        </>,
      ),
    ],
  },
  {
    slug: 'ship',
    title: 'Review and ship',
    group: 'Build',
    intro:
      'You start every release. Agents never ship. Read the changes and check results before you make them live.',
    sections: [
      section(
        'review',
        'Review the work',
        <p>
          Check that the change does what you asked, that its checks passed, and that any data
          change is understood. The combined task, Changes and Checks pages are not connected in
          this version. Do not treat the placeholder as a completed review.
        </p>,
      ),
      section(
        'ship',
        'Start a release',
        <>
          <p>
            The task-page Ship… action is not available yet. The working CLI path uploads the
            current folder when you run <code>deploy</code>. Check the selected project and
            coordinator before running it. {docLink('cli', 'CLI')} explains selection and output.
          </p>
          <p>
            Project releases currently run on the coordinator. Apps placed on other computers cannot
            use this project release path yet. Do not assume merging a pull request starts a v2
            release in this version.
          </p>
        </>,
      ),
      section(
        'follow',
        'Follow the result',
        <p>
          Open the project’s Releases page to see Prepare, Verify, Activate and Watch. A failed
          Verify leaves its previous release in place. Once activation begins, read the recorded
          result before retrying. See {docLink('releases', 'Releases and rollback')}.
        </p>,
      ),
    ],
  },
  {
    slug: 'screenshots',
    title: 'Screenshots and markup',
    group: 'Build',
    intro:
      'Previews are screenshots you ask for. Screenshot capture and markup are not available in this version.',
    sections: [
      section(
        'available',
        'What you can use today',
        <p>
          Describe the screen, the action you took, and the result you expected in your message.
          There is no working take-screenshot, Pen, Arrow or Text flow to document yet.
        </p>,
      ),
      section(
        'attachments',
        'Attachments on iPhone',
        <p>
          The system photo and file pickers can save an attachment locally. Sending attachments is
          not supported by this coordinator. Remove the attachment to send the text. Selecting a
          photo does not give the app access to your whole library.
        </p>,
      ),
    ],
  },
  {
    slug: 'live',
    title: 'Live and incidents',
    group: 'Run',
    intro:
      'Open Live to see running apps grouped by computer. Each app has a state and a plain-language reason.',
    sections: [
      section(
        'health',
        'Read the health',
        <>
          <p>
            <a href="/dashboard/live">Live</a> distinguishes Healthy, Warning, Failing and Stopped.
            A missing measurement is unavailable, not a healthy result.
          </p>
          <p>
            Web apps can report HTTP health. Workers can report job failures, queue depth, restarts
            and heartbeat. Those numbers appear only when the app or computer reports them.
          </p>
        </>,
      ),
      section(
        'incident',
        'When an app fails',
        <ol>
          <li>Open the app in Live and read the reason.</li>
          <li>Check its project’s Logs and latest release.</li>
          <li>Review any Warden decision in Waiting on you.</li>
          <li>If the change caused the problem, review a whole-project rollback.</li>
        </ol>,
      ),
      section(
        'warden',
        'Warden and rollback',
        <p>
          A failure can produce a rollback decision. Answering it on Live or in Waiting on you
          answers the same item. Warden asks by default; only an applicable Allow rule can permit
          automatic rollback. Data loss still needs your explicit confirmation. See{' '}
          {docLink('releases', 'Releases and rollback')}.
        </p>,
      ),
    ],
  },
  {
    slug: 'releases',
    title: 'Releases and rollback',
    group: 'Run',
    intro:
      'A release includes every app in a project and its recorded data changes. You start every release. Agents never ship.',
    sections: [
      section(
        'how-a-release-runs',
        'How a release runs',
        <>
          <Steps
            steps={[
              { icon: 'cloud', text: 'Prepare · build every app in the project' },
              { icon: 'check', text: 'Verify · start on a copy and check health' },
              { icon: 'running', text: 'Activate · switch the project and run its data changes' },
              {
                icon: 'pulse',
                text: 'Watch · check the running processes for ten minutes by default',
              },
            ]}
          />
          <p>
            If Verify fails, the project stays on its previous release. Follow progress in the
            project’s Releases page. Activation can briefly stop apps; it is not a zero-downtime
            switch.
          </p>
          <p>
            This path supports apps on the coordinator. Remote computers and apps that need host
            access cannot use isolated project verification yet.
          </p>
        </>,
      ),
      section(
        'rolling-back',
        'Rolling back',
        <>
          <p>
            Open a release, choose Roll back release, and select an earlier release. Every app moves
            together. A complete earlier project release must exist; an old single-app build is not
            enough.
          </p>
          <div className="docs-v2-note">
            When a data change cannot be reversed, rollback needs the pre-release backup. Review
            which apps are affected and the data cutoff before choosing Restore backup and roll
            back. Changes after that backup can be lost.
          </div>
          <p>
            Ordinary migration jobs have no reverse command in this version. They need backup
            restore. Only registered reverse operations can undo a change without restoring data.
          </p>
        </>,
      ),
      section(
        'warden',
        'When Warden rolls back by itself',
        <>
          <p>
            Warden asks first by default. In <a href="/dashboard/settings/approvals">Approvals</a>,
            a matching unrestricted rollback rule can allow it to act. A project rule takes
            precedence over a general rule. Never blocks the action.
          </p>
          <p>
            A free-text limit keeps the action on Ask me. It does not implement a ten-minute-only
            permission. Automatic permission never skips a data-loss confirmation.
          </p>
        </>,
      ),
      section(
        'cli',
        'From the CLI',
        <>
          <p>
            <code>deploy releases [app]</code> lists project releases.{' '}
            <code>deploy rollback [app]</code> reviews a previous release and asks for confirmation.
            Use the app to review an irreversible data restore.
          </p>
          {command(
            '$ deploy releases home-gym\n9c3e1fa  live  2 apps\n81be0d2  superseded  2 apps',
          )}
          <p className="docs-v2-caption">
            Recorded against an isolated CLI fixture. These release IDs and app counts are examples.
            See {docLink('cli', 'CLI')} for output and exit codes.
          </p>
        </>,
      ),
    ],
  },
  {
    slug: 'projects',
    title: 'Projects and apps',
    group: 'Run',
    intro:
      'Keep source, running apps and their settings together in Projects. An app has Overview and Settings; project-wide work belongs to the project.',
    sections: [
      section(
        'find',
        'Find your project',
        <p>
          Open <a href="/dashboard/projects">Projects</a> and select a project. A project with one
          app opens its app overview. Tabs appear when there is content to show. Code reads the
          repository; Issues shows open and closed issues.
        </p>,
      ),
      section(
        'apps',
        'Apps and releases',
        <p>
          Add an app attaches an existing app you own. It does not create a new running app.
          Releases move the project’s apps together. The Pull requests route is still a placeholder
          in this version.
        </p>,
      ),
      section(
        'configuration',
        'Variables and secrets',
        <>
          <p>
            Open project Settings. Set a value for all apps, or give one app an override. Secret
            values are not shown again; the page shows whether they are set. Changes apply on the
            next release.
          </p>
          <p>
            For apps using deploy.yaml, declare configuration names and references in that file. The
            older single-app runtime does not yet read the new project settings. See{' '}
            {docLink('deploy-yaml', 'deploy.yaml')}.
          </p>
        </>,
      ),
      section(
        'logs',
        'Read logs',
        <p>
          Open project Logs and choose an app or all apps. You can filter the returned text by
          level, pause the view, or reconnect. Logs show a tail of output; they do not promise a
          complete hour of history.
        </p>,
      ),
    ],
  },
  {
    slug: 'backups',
    title: 'Backups and restore',
    group: 'Run',
    intro:
      'Restore to a copy first. Check that copy before switching the live project to its data.',
    sections: [
      section(
        'check',
        'Check your backups',
        <>
          <p>
            Open <a href="/dashboard/settings/backups">Settings → Backups</a>. Review capture time,
            contents, location and test-restore status. Administrators can also see the saved backup
            schedules. A schedule can be disabled; nightly backups are not automatically enabled.
          </p>
          <p>
            A saved backup record does not prove an external disk copy finished. Keep another copy
            somewhere safe and check it.
          </p>
        </>,
      ),
      section(
        'copy',
        'Restore to a copy',
        <ol>
          <li>Select a supported backup and choose Restore to a copy.</li>
          <li>Wait for the copy to be ready.</li>
          <li>
            Open the copy in a browser on the coordinator and check the data. Its localhost address
            will not work from another computer or iPhone.
          </li>
          <li>
            Choose I checked it · Switch when you want that data live. Cancel removes the unused
            copy.
          </li>
        </ol>,
      ),
      section(
        'switch',
        'Switch after checking',
        <p>
          Switch backs up the current data, stops its writers, and uses the project release steps to
          activate the checked copy. Keep the page’s result and release link. If the project changed
          while you checked the copy, the switch is refused so you can start again with the current
          project.
        </p>,
      ),
      section(
        'limits',
        'Which backups can restore',
        <p>
          Copy restore needs a local app archive with a compatible deploy.yaml configuration and a
          complete current project release. Remote backups and older archive formats show why
          restore is unavailable. Coordinator recovery bundles can be verified and rehearsed here
          with their passphrase; this page does not restore the coordinator itself.
        </p>,
      ),
    ],
  },
  {
    slug: 'updates',
    title: 'Updates',
    group: 'Run',
    intro:
      'The computer list reports versions when they are available. Other computers do not install updates automatically in this version.',
    sections: [
      section(
        'versions',
        'Check versions',
        <p>
          Open <a href="/dashboard/computers?updates=1">Computers → Updates</a>. If deploy.local has
          a Live project release, it is shown as the target. Missing version information stays
          unavailable. An idle computer marked ready has not installed anything.
        </p>,
      ),
      section(
        'cli',
        'Update the CLI',
        <p>
          <code>deploy upgrade</code> updates the CLI from its configured coordinator. It does not
          update the coordinator or every computer in your home. Check <code>deploy version</code>{' '}
          to see the CLI version. These commands are listed in {docLink('cli', 'CLI')}.
        </p>,
      ),
      section(
        'coordinator',
        'Update the coordinator',
        <p>
          Use the installation’s existing source or release update process. A host-coordinator
          self-release adapter and automatic worker installer are not implemented. The Restarting
          page can appear while the coordinator is unavailable; it does not mean an update
          succeeded.
        </p>,
      ),
    ],
  },
  {
    slug: 'agents',
    title: 'Agents',
    group: 'Agents',
    intro:
      'Give an agent a clear job. Its instructions, computers and approval rules are separate choices.',
    sections: [
      section(
        'built-in',
        'Scout and Warden',
        <p>
          Open an agent from the sidebar to read its conversation. Use its menu for Info or Tune.
          Tune saves instructions and assigned computers. It links to Approvals and Models rather
          than keeping another copy of those settings.
        </p>,
      ),
      section(
        'new',
        'Add an agent',
        <ol>
          <li>
            Open <a href="/dashboard/agents/new">New agent</a>.
          </li>
          <li>
            Describe the job and ask Scout for a draft. This needs a configured compatible model
            provider.
          </li>
          <li>Review the name, instructions and computers. Edit anything unclear.</li>
          <li>Create the agent. Its actions start on Ask me.</li>
        </ol>,
      ),
      section(
        'limits',
        'What runs today',
        <p>
          Agent chat can answer using a model, but has no tools. Creating a standing agent saves its
          definition; it does not start a scheduled background job. The built-in release health and
          rollback paths run separately. Agents never start releases. See{' '}
          {docLink('approvals', 'Approvals')}.
        </p>,
      ),
    ],
  },
  {
    slug: 'approvals',
    title: 'Approvals',
    group: 'Agents',
    intro: 'Agents start on Ask me. Review rules in one place, under Settings → Approvals.',
    sections: [
      section(
        'modes',
        'Choose a rule',
        <>
          <p>
            Open <a href="/dashboard/settings/approvals">Approvals</a> and select an agent’s action.
            Ask me requires a decision. Allowed can permit an action where that action supports the
            rule. Never refuses it. Shipping always remains yours.
          </p>
          <p>
            You can save rules for one project. A project rule overrides the general rule for that
            action. Text limits that cannot be checked automatically keep asking.
          </p>
        </>,
      ),
      section(
        'rollback',
        'Rollback rules',
        <p>
          Rollback checks these rules both when Warden proposes it and when it starts. A later Never
          rule blocks an older pending decision. A backup restore that loses newer data still needs
          your explicit confirmation.
        </p>,
      ),
      section(
        'coverage',
        'Current coverage',
        <p>
          The matrix saves rules for several actions, but complete enforcement is currently
          connected only to rollback. Do not rely on it as a permission boundary for older merge,
          restart, install, secret, screen or spending tools. Screen tools also have their own
          per-task permission requests.
        </p>,
      ),
    ],
  },
  {
    slug: 'models',
    title: 'Models',
    group: 'Agents',
    intro:
      'Computers → Models shows reported model choices and usage. Missing information is shown as unavailable.',
    sections: [
      section(
        'reported',
        'See what is available',
        <p>
          Open <a href="/dashboard/computers/models">Models</a>. Choices come from computer reports.
          Weekly usage appears only when reported; it is not a live bill or a spending cap. Local
          inventory appears only when a computer supplies it.
        </p>,
      ),
      section(
        'defaults',
        'Save defaults',
        <p>
          You can save defaults for writing code, reviewing and answering questions here. This is
          their only settings page. These saved defaults are not yet connected to task execution in
          this version.
        </p>,
      ),
      section(
        'chat',
        'Choose for one chat',
        <p>
          A composer’s model choice belongs to that chat. It does not change the saved computer
          defaults. The web Home composer is still a placeholder. Agent drafting and chat currently
          require a compatible HTTP provider; a local subscription alone does not connect them.
        </p>,
      ),
    ],
  },
  {
    slug: 'cli',
    title: 'CLI',
    group: 'Reference',
    intro:
      'The deploy command works from a project folder or with an explicit app name. Use --help to see the commands in your installed version.',
    sections: [
      section(
        'commands',
        'Command groups',
        <>
          <p>
            This is the command list from the committed CLI help. Optional arguments use square
            brackets; do not type the brackets.
          </p>
          {command(
            `Ship\n  deploy\n  deploy plan [app]\n  deploy rollback [app]\n  deploy releases [app]\n\nWatch\n  deploy status\n  deploy logs [app]\n  deploy open [app]\n  deploy ssh [app]\n\nDecide\n  deploy inbox\n  deploy inbox <id> <action> --yes\n\nAgents\n  deploy task "<what to do>" --on <computer> --agent scout\n  deploy tasks\n\nApps and computers\n  deploy discover [search]\n  deploy install <app>\n  deploy remove [app]\n  deploy computers\n  deploy computer join\n\nAccount\n  deploy login\n  deploy logout\n  deploy whoami\n  deploy upgrade\n  deploy version`,
          )}
        </>,
      ),
      section(
        'selection',
        'Choose the app and coordinator',
        <>
          <p>
            With deploy.yaml in the current folder, an omitted app name defaults to the folder name.
            Otherwise give the name explicitly. Use <code>-u</code> or <code>--url</code> to select
            the coordinator. Login uses a password; it does not open a browser sign-in flow yet.
          </p>
          <p>
            <code>--json</code> requests machine output. <code>-y</code> or <code>--yes</code> skips
            ordinary confirmations. For an inbox answer, you must still provide the item ID and
            action ID. <code>deploy help advanced</code> lists compatibility and maintenance
            commands.
          </p>
        </>,
      ),
      section(
        'output',
        'Read the result',
        <>
          {command(
            '$ deploy status\nLive · 2 running · 1 failing\n\nSER  online · Coordinator\n  ● home-gym sync  Failing\n  ● home-gym  Running  Health checks unavailable\n\nbazzite  online · Run apps\n  ● Vaultwarden  Healthy\n\n! 1 waiting on you  · deploy inbox',
          )}
          <p className="docs-v2-caption">
            Recorded fixture output from the CLI evidence, with exit code 3. These names and counts
            are examples.
          </p>
          <p>
            Exit 0 means success, 1 means failure, 2 means a usage or unsupported-command error, and
            3 means status found something Waiting on you. JSON errors go to standard error. Raw log
            output uses separate output records.
          </p>
        </>,
      ),
      section(
        'release-output',
        'Follow a release',
        <>
          <p>
            Use <code>--build</code> with logs to inspect a build. Older upload receipts do not
            report separate Verify or Watch steps, so the CLI labels those skipped. Read the project
            Releases page for the full project result.
          </p>
          <p>
            A release can take longer than the CLI’s default 600-second wait.{' '}
            <code>--wait-timeout &lt;seconds&gt;</code> allows more time. A timeout means still
            running, not Live. Irreversible rollback needs data-loss review in the app.
          </p>
        </>,
      ),
    ],
  },
  {
    slug: 'deploy-yaml',
    title: 'deploy.yaml',
    group: 'Reference',
    intro:
      'Put deploy.yaml in the project folder to describe an app’s components, configuration, data and routes.',
    sections: [
      section(
        'example',
        'A small web app',
        <>
          <p>
            This example builds the current folder. The app must listen on port 3000 and answer
            /health. The hostname follows the current .local routing.
          </p>
          {command(
            `apiVersion: deploy.local/v1\nkind: Application\nmetadata:\n  name: home-gym\ncomponents:\n  web:\n    build:\n      context: .\n    role: web\n    interfaces:\n      http:\n        port: 3000\n        protocol: http\n    health:\n      interface: http\n      path: /health\nroutes:\n  public:\n    hostname: home-gym.local\n    to: web.http`,
          )}
        </>,
      ),
      section(
        'parts',
        'Describe the parts',
        <ul>
          <li>
            <code>components</code> defines images or builds, interfaces, environment and health.
          </li>
          <li>
            <code>configuration</code> declares named values and secrets. Reference them from
            component environment fields.
          </li>
          <li>
            <code>resources</code> declares persistent volumes. Mount them where an app stores its
            data.
          </li>
          <li>
            <code>jobs</code> runs declared commands, such as a migration before traffic.
          </li>
          <li>
            <code>routes</code> connects a hostname to a component interface.
          </li>
        </ul>,
      ),
      section(
        'data',
        'Plan for data changes',
        <p>
          Migration jobs do not have general reverse commands. The project release path treats them
          as irreversible and requires a pre-release backup. Host mounts, external data and
          privileged apps cannot use isolated project verification. Review{' '}
          {docLink('releases', 'Releases and rollback')} before shipping data changes.
        </p>,
      ),
    ],
  },
  {
    slug: 'architecture',
    title: 'How it works',
    group: 'Reference',
    intro:
      'One coordinator keeps the shared records. Your other computers do the work they are equipped to do.',
    sections: [
      section(
        'coordinator',
        'The coordinator',
        <p>
          The coordinator stores accounts, projects, conversations, decisions and release history.
          The edge serves local HTTPS addresses and forwards app traffic. In the split-process
          installation, the edge can show Restarting while the coordinator is unavailable.
        </p>,
      ),
      section(
        'computers',
        'The computers',
        <p>
          Task workers report their capabilities and accept assigned work. Running work stays on its
          assigned computer when you change devices. App hosting is a separate capability. Current
          v2 project releases stage and activate only on the coordinator.
        </p>,
      ),
      section(
        'clients',
        'The clients',
        <p>
          The web app, desktop shell, iPhone and CLI read shared state. Conversation items and
          decisions use typed records. Answering a decision updates that item, rather than creating
          a separate answer on each device. Reconnecting clients read the saved result.
        </p>,
      ),
      section(
        'network',
        'Your home network',
        <p>
          Local names and certificate trust let devices reach the coordinator and apps. Use the
          address shown for an app; current apps can use names such as home-gym.local. Access away
          from home is outside this version’s supported flow.
        </p>,
      ),
    ],
  },
  {
    slug: 'troubleshooting',
    title: 'Troubleshooting',
    group: 'Reference',
    intro:
      'Start with the message on the page. Check the computer, connection and latest release before retrying a change.',
    sections: [
      section(
        'connection',
        'Cannot reach deploy.local',
        <p>
          Make sure the coordinator is on and both devices are on the same home network. Check local
          name resolution and firewall access. If a certificate warning appears, trust your own
          coordinator’s CA certificate. See {docLink('install', 'Install on a computer')}.
        </p>,
      ),
      section(
        'computer',
        'A computer is offline',
        <p>
          Open Computers and check its last reported state. On a desktop worker, confirm the app is
          running and signed in. If Docker is unavailable, check that it is running for the account
          that hosts apps. An installed Docker command alone does not mean its engine is reachable.
        </p>,
      ),
      section(
        'release',
        'A release failed or is still running',
        <>
          <p>
            Read the failed step in project Releases, then inspect Logs. Failed Verify leaves the
            previous release in place. A CLI wait timeout can happen while Watch continues; check
            the release before starting again.
          </p>
          <p>
            If a crash leaves a release reserved, automatic recovery is not available yet. Keep its
            error and release ID for investigation. Do not delete release records to force another
            attempt.
          </p>
        </>,
      ),
      section(
        'restore',
        'A restore copy will not open',
        <p>
          Open its localhost address in a browser on the coordinator. Another computer or iPhone
          cannot reach that copy address. An unavailable restore explains its unsupported format or
          configuration. Do not substitute an in-place restore for the copy check.
        </p>,
      ),
      section(
        'model',
        'Scout cannot draft or reply',
        <p>
          Agent drafting and chat need a configured compatible HTTP provider. Computer model reports
          and a local CLI subscription do not supply that connection. A failed send keeps the text
          so you can retry after correcting the provider connection.
        </p>,
      ),
      section(
        'cli',
        'The CLI needs a project',
        <>
          {command(
            '$ deploy logs\n✗ Which app? This folder is not a project.\n  Next: deploy logs home-gym, or run it in the project folder',
          )}
          <p>
            This recorded example exits with code 2. Give the app name or run the command in its
            folder. See {docLink('cli', 'CLI')}.
          </p>
        </>,
      ),
    ],
  },
];

export function searchDocs(query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return docs.flatMap((doc) => {
    const matches = (value: string) =>
      terms.every((term) => value.toLocaleLowerCase().includes(term));
    return [
      ...(matches(doc.title)
        ? [{ href: docPath(doc.slug), title: doc.title, detail: doc.group }]
        : []),
      ...doc.sections
        .filter((entry) => matches(`${doc.title} ${entry.title}`))
        .map((entry) => ({
          href: `${docPath(doc.slug)}#${entry.id}`,
          title: entry.title,
          detail: doc.title,
        })),
    ];
  });
}
