import type { ReactNode } from 'react';
import { Group } from '../../components/ui/v2/Group';
import { Setting } from '../../components/ui/v2/Setting';
import { Icon } from '../../components/ui/v2/shared';
import { Steps } from '../../components/ui/v2/Steps';
import { Term } from '../../components/ui/v2/Term';
import { DocsCommand } from './command.client';
import { DesktopDownload } from './desktop.client';

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
// The coordinator serves these installers itself (server/cli-download.ts).
export const cliInstallCommands = {
  posix: 'curl -fsSL http://deploy.local/install | sh',
  windows: 'irm http://deploy.local/install.ps1 | iex',
};
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
            It needs Docker to run apps. The local setup installer asks whether to start fresh or
            recover from a backup. For a fresh home, it prints a setup code and a browser address.
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
            Open <a href="/setup">/setup</a> from a computer on the same home network. Enter the
            installer’s code, choose a username and a password of at least 12 characters, and create
            the first account. This account is the administrator.
          </p>
          <p>
            After this browser trusts your home certificate, Home offers to add a passkey. You can
            also add one in Settings → Account. It is optional; your password always works.
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
            Type what you want on <a href="/dashboard">Home</a> to start work. Review the resulting
            task before choosing Ship…. You start every release. Agents never ship.
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
                'Agent',
                'A standing job you create. It starts a task in the background on its schedule and asks you before it acts. Agents never ship.',
              ],
              [
                'Ship…',
                'The action for starting a release yourself, in the task header and This task panel.',
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
      'Choose a computer that can stay on and remain connected to your home network. It will be the coordinator. Then add your other computers with the desktop app or the CLI.',
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
            Build the source checkout on your always-on computer, then run its local setup installer
            before starting the coordinator. Choose fresh to create the home certificate and print a
            single-use setup code. Keep the same data folder for setup and startup.
          </p>
          {command(
            'git clone https://github.com/gabrielcsapo/deploy.local.git\ncd deploy.local\npnpm install --frozen-lockfile\npnpm build\npnpm exec tsx server/v2/setup-installer.ts\npnpm start',
          )}
          <p>
            Open the printed address ending in <a href="/setup">/setup</a> and enter the code to
            create your first account with a password. The code expires after 30 minutes; run the
            local setup installer again if it expires before account creation. The coordinator keeps
            accounts, project history and certificates in its persistent data folder.
          </p>
        </>,
      ),
      section(
        'recover',
        'Recover a home',
        <p>
          Choose recover in the local setup installer with your recovery bundle, its passphrase and
          an empty replacement data folder. Start the replacement coordinator and open{' '}
          <a href="/recover">/recover</a> to check the result after signing in. Recovery does not
          replace a running coordinator in place. For app data, use{' '}
          {docLink('backups', 'Backups and restore')}.
        </p>,
      ),
      section(
        'other-computers',
        'Add your other computers',
        <>
          <p>
            <span className="docs-v2-wide">
              Each laptop or desktop can join as a computer that takes tasks for your agents.{' '}
            </span>
            Use the desktop app on a computer you sit at, and the CLI on a server without a screen.
          </p>
          <h3 id="desktop">The desktop app</h3>
          <DesktopDownload />
          {/* Phones get the short version from the iPhone board; the app runs on a Mac anyway. */}
          <div className="docs-v2-narrow">
            <Steps
              numbered
              steps={[
                {
                  text: (
                    <>
                      Open <strong>deploy.local Desktop</strong>; it finds your coordinator.
                    </>
                  ),
                },
                { text: 'Check the certificate, then sign in.' },
                {
                  text: (
                    <>
                      Choose what it helps with, then <strong>Add</strong>.
                    </>
                  ),
                },
              ]}
            />
          </div>
          <div className="docs-v2-wide">
            <Steps
              numbered
              steps={[
                {
                  text: (
                    <>
                      Open <strong>deploy.local Desktop</strong>. It finds deploy.local on your
                      network, or you type your coordinator’s address.
                    </>
                  ),
                },
                {
                  text: 'Check that the certificate it shows is your coordinator’s, then sign in.',
                },
                {
                  text: (
                    <>
                      Choose what it helps with. <strong>Take tasks</strong> is on;{' '}
                      <strong>Use the screen</strong> asks for macOS permissions first.
                    </>
                  ),
                },
                {
                  text: (
                    <>
                      Choose <strong>Add</strong>. It appears in Computers. Closing the window keeps
                      it working; Quit stops it.
                    </>
                  ),
                },
              ]}
            />
          </div>
          <div className="dl-notice docs-v2-notice docs-v2-wide">
            <Icon name="shield" />
            <span>
              The app isn’t notarized yet, so macOS stops it the first time. Open System Settings →
              Privacy &amp; Security and choose Open Anyway. You do this once.
            </span>
          </div>
          <h3 id="cli">The CLI</h3>
          <p className="docs-v2-wide">
            For a computer without a screen, or to deploy from a terminal. Run it on each computer
            that needs the CLI, with your coordinator’s address.
          </p>
          <DocsCommand label="macOS and Linux" command={cliInstallCommands.posix} />
          <DocsCommand label="Windows PowerShell" command={cliInstallCommands.windows} />
          <p>
            Then run <code>deploy login</code> and approve the matching code in your browser. Later,{' '}
            <code>deploy upgrade</code> replaces the CLI with the build your coordinator serves.
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
        </>,
      ),
      section(
        'passkeys',
        'Add a passkey',
        <p>
          Passkeys become available over HTTPS after the browser trusts the certificate. Home offers
          one once, and Settings → Account keeps Add a passkey available. Sign-in offers a passkey
          first when your account has one; Use a password remains available.
        </p>,
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
              On that Mac or Linux computer, {docLink('install#cli', 'install the CLI')} and run the
              join command shown in the dialog. Enter the code when asked.
            </li>
            <li>
              Wait for the computer to appear as connected. Make another code if the first expires.
            </li>
          </ol>
          <p>
            The dialog supplies the coordinator address. Linux enrollment needs administrator
            privileges. On macOS, run enrollment from your usual desktop account.
          </p>
          <p>
            On a Mac you sit at, use the desktop app instead. It adds the computer when you sign in,
            without a join code. See {docLink('install#desktop', 'The desktop app')}.
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
          As the administrator, open the computer and choose Remove. It must have no assigned apps,
          unfinished work or model-serving role. The coordinator cannot be removed. Removal revokes
          access and leaves files on disk. Moving apps and data is unavailable here because this
          action only disconnects an idle computer.
        </p>,
      ),
    ],
  },
  {
    slug: 'devices',
    title: 'Your devices',
    group: 'Start',
    intro:
      'Use your browser, the desktop app, or iPhone on your home network. They connect to the same coordinator.',
    sections: [
      section(
        'browser',
        'In a browser',
        <p>
          Open deploy.local and sign in with your passkey or password. Use the same account to see
          the same projects and Waiting on you. Trust your home certificate on each browser device.
          If your session expires, Sign in again returns you to the page you were using.
        </p>,
      ),
      section(
        'desktop',
        'On a desktop computer',
        <>
          <p>
            The desktop app loads the web app and adds a tray, notifications and a task worker.
            During setup, verify the coordinator’s certificate fingerprint, sign in with your
            password and choose supported roles. The computer then appears in Computers.
          </p>
          <p>
            The tray shows Waiting on you, Live and this computer’s activity. Take new tasks stops
            new work from arriving without interrupting the current task. Closing the window leaves
            the worker running; Quit stops it. Notifications open the decision, with action buttons
            on supported macOS notifications and click-to-review on Windows and Linux.
          </p>
          <p>
            Use the screen requires the macOS helper, system permissions and approval for each task.
            Run apps and Serve models are disabled in desktop setup because its bundled worker
            cannot configure those services. Download the Mac app from{' '}
            {docLink('install#desktop', 'The desktop app')}; Windows and Linux builds aren’t
            published yet.
          </p>
        </>,
      ),
      section(
        'iphone',
        'Pair an iPhone',
        <>
          <ol>
            <li>On a signed-in computer, open Settings → Devices and choose Add iPhone.</li>
            <li>In the iPhone app, tap Scan and scan the QR code.</li>
            <li>The app checks the certificate carried by the code and signs in.</li>
          </ol>
          <p>
            The code works once and expires in five minutes. The iPhone app has Work, Projects,
            Live, Computers and Settings. It shares decisions and release progress with your other
            devices; computer administration stays on a computer.
          </p>
        </>,
      ),
      section(
        'notifications',
        'Choose notifications',
        <p>
          iPhone push notifications cover Waiting on you and failing apps. Approve and Not now
          require unlocking; decisions needing confirmation open in the app. In Settings →
          Notifications, choose Decisions, Failing apps and Quiet hours. Quiet hours run from 10 PM
          to 7 AM in your phone’s timezone, except rollback decisions. Turning a category off or
          muting an agent still silences those alerts. iPhone notification permission and Focus also
          affect delivery.
        </p>,
      ),
      section(
        'remove',
        'Remove a device',
        <p>
          Open Settings → Devices on the web, or the paired-devices sheet on iPhone, and choose
          Remove. This signs that paired device out and stops push delivery to it. Pair it again if
          you want it to reconnect.
        </p>,
      ),
      section(
        'offline',
        'When disconnected',
        <p>
          Only on your home network. The desktop app retries the connection and shows last-known
          information with the coordinator’s name. iPhone keeps saved information and drafts;
          decisions are disabled while offline. Saved health is not current health, and neither app
          silently replays a decision when the connection returns.
        </p>,
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
            Type your request on <a href="/dashboard">Home</a> and send it. Home opens a task;
            replies stay in its Chat tab. The work log folds the agent’s steps so you can read the
            result and any questions. The composer’s model choice applies only to this chat.
          </p>
          <p>
            The project’s New task action also opens Home. From a terminal, use{' '}
            <code>deploy task "&lt;what to do&gt;" --on &lt;computer&gt;</code>;
            <code> deploy tasks</code> lists work. The CLI starts your own tasks only; to start an
            agent’s run, use Run now on its page. See {docLink('ship', 'Review and ship')} when the
            work is ready.
          </p>
        </>,
      ),
      section(
        'questions',
        'Ask a question',
        <p>
          Open one of your agents from the sidebar to ask about its work. Agent chat uses a
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
          Open the task’s Chat, Changes and Checks tabs. Changes shows the files and lines changed;
          Checks shows the recorded results and command output for the version being reviewed. A
          pull request from the project’s list opens this same task page. Check the result against
          your request and understand any data change before making it live.
        </p>,
      ),
      section(
        'task-panel',
        'Read This task',
        <p>
          Open This task from the header to see the project, repository, computer, changed-file
          totals, checks, screenshots and releases together. The panel links to Changes and Checks
          and keeps Ship… within reach. Ship is disabled when no source revision can be resolved.
          Update from main, Publish pull request and Run again are disabled because these controls
          have no connected command on this page.
        </p>,
      ),
      section(
        'ship',
        'Start a release',
        <>
          <p>
            Choose Ship… in the task header or This task panel. Review the source revision and edit
            each app’s Runs on, Address, Who can open it and Data choices. Runs on lists online
            computers with Run apps; Address must be a local hostname. Choose Ship to start the
            whole project’s release.
          </p>
          <p>
            Just me and Everyone at home control whether the app appears in Apps at home; they do
            not add sign-in protection to its address. Existing live data cannot be replaced by
            choosing New data, and an existing running app cannot move to another computer in this
            dialog because data transfer is not part of Ship.
          </p>
        </>,
      ),
      section(
        'merge',
        'Merge a pull request',
        <p>
          An open pull request offers Merge only after its current changes load. This updates the
          target branch and queues any configured push pipeline. It does not open the Ship dialog; a
          pipeline releases only when deploy.yaml includes that release step. Review Releases before
          starting another release yourself.
        </p>,
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
      'Previews are screenshots you ask for, taken on the computer assigned to the task. They do not run continuously.',
    sections: [
      section(
        'request',
        'Ask for a screenshot',
        <>
          <p>
            In the web or desktop task composer, open + and choose A screenshot of the app. Choose
            Web, iOS simulator or Desktop window and enter the requested address or target. Start a
            task first if you are on Home. The screenshots appear in its conversation and This task.
          </p>
          <ul>
            <li>
              Web opens the supplied URL in a separate headless browser at phone and desktop widths.
            </li>
            <li>iOS simulator needs a booted simulator on a Mac; enter its simulator UUID.</li>
            <li>
              Desktop window needs the approved window ID and an active Use the screen permission
              for this task.
            </li>
          </ul>
          <p>
            The assigned worker needs the capture tools for that target. Requests expire after a
            minute if they cannot finish, so an old request does not capture a screen later.
          </p>
        </>,
      ),
      section(
        'markup',
        'Mark it up and send',
        <p>
          Open a screenshot to mark it up. Use Pen, Arrow or Text, choose red, yellow or blue, and
          use Undo to remove the last mark. Send includes the marked image and its annotations in
          your task follow-up. The original screenshot stays unchanged, and a failed send keeps your
          draft.
        </p>,
      ),
      section(
        'attachments',
        'Add photos and files',
        <p>
          The web and desktop composer’s + menu offers Photos, Take a photo, Files and A project
          file. Only selected files are shared. Upload up to eight files per message, at most 10 MiB
          each and 20 MiB together. A project file comes from the saved repository snapshot.
        </p>,
      ),
      section(
        'iphone',
        'On iPhone',
        <p>
          Native iPhone attachment sending, screenshot viewing and markup are unavailable because
          that client has not connected the media APIs; open the task on a computer. Its system
          photo and file pickers save selections locally, and you must remove them to send text.
          Selecting a photo never gives the app access to your whole library.
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
          <li>Review any rollback decision from deploy.local in Waiting on you.</li>
          <li>If the change caused the problem, review a whole-project rollback.</li>
        </ol>,
      ),
      section(
        'rollback',
        'Rollback after a failed release',
        <p>
          deploy.local checks each release. When a release fails its health checks, or a worker app
          fails within an hour of a release, it asks in Waiting on you to roll back the whole
          project. The decision shows as from deploy.local. Answering on Live or in Waiting on you
          answers the same item. Live shows recorded automatic rollbacks as Automatically rolled
          back, with links to their reports. Data loss still needs your explicit confirmation. See{' '}
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
            Apps can run on the coordinator or other connected computers with the project-release
            worker. Every app verifies before any computer activates, and addresses switch only
            after all computers acknowledge activation. Apps needing privileged or direct host
            access are refused because verification cannot isolate them safely.
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
            A migration is a recorded data-changing job. Jobs with reverse commands in{' '}
            <code>release-migrations.json</code> can be undone in reverse activation order, using
            their original release’s image and settings. Jobs without a reverse command need the
            pre-release backup. See {docLink('deploy-yaml', 'deploy.yaml')} for the metadata format.
          </p>
        </>,
      ),
      section(
        'recovery',
        'After a restart',
        <p>
          The coordinator reads saved release progress on startup. It finishes an activation already
          published to app addresses, or restores the previous processes after a partial switch. If
          a migration or restore was interrupted and its outcome is uncertain, the project stays
          stopped and locked for recovery rather than repeating the data change. Read the recorded
          error; do not delete its records to force a retry.
        </p>,
      ),
      section(
        'changes',
        'Changes during a release',
        <p>
          Another release, rollback, restart, scale change or configuration edit is blocked while
          the project’s release is running. Wait for its result before making another change.
          Project removal is also blocked until the release finishes.
        </p>,
      ),
      section(
        'automatic-rollback',
        'When deploy.local rolls back by itself',
        <>
          <p>
            After a failed release, deploy.local asks first by default. In{' '}
            <a href="/dashboard/settings/approvals">Settings → Agents and approvals</a>, the After a
            failed release section has one rule, Roll back a release. Ask me puts the decision in
            Waiting on you. Allowed rolls back automatically. Never blocks the action. A matching
            project rule takes precedence over this general rule.
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
        'clone',
        'Clone and push',
        <>
          <p>
            Clone a project over HTTPS or SSH. For SSH, add this computer’s public key (for example,{' '}
            <code>~/.ssh/id_ed25519.pub</code>) in{' '}
            <a href="/dashboard/settings/account">Settings → Account and SSH keys</a>. Never paste
            the private key. Each key belongs to one account and reaches that account’s
            repositories. SSH pushes start the same checks as HTTPS pushes.
          </p>
          {command('git clone ssh://git@deploy.local:2222/home-gym.git')}
          <p>
            Before connecting, compare the host fingerprint SSH shows with the one in Settings, or
            copy its known_hosts line into <code>~/.ssh/known_hosts</code>. If the host key changes
            unexpectedly, check with whoever runs SER before trusting the new one. Add this to{' '}
            <code>~/.ssh/config</code> to use the shorter address:
          </p>
          {command(
            'Host deploy.local\n  HostName deploy.local\n  Port 2222\n  User git\n  IdentityFile ~/.ssh/id_ed25519\n  IgnoreUnknown WarnWeakCrypto\n  WarnWeakCrypto no-pq-kex',
          )}
          {command('git clone git@deploy.local:home-gym.git')}
          <p>
            OpenSSH 10.1 and later warn that the connection does not use post-quantum key exchange,
            which deploy.local’s SSH server does not offer yet; the last two lines silence that one
            warning for this host. SSH listens on port 2222. Set <code>DEPLOY_SSH_PORT</code> to
            another port, or <code>0</code> to turn SSH off, then restart. The host key lives in{' '}
            <code>DEPLOY_DATA_DIR/ssh_host_ed25519_key</code>; keep it across upgrades.
          </p>
        </>,
      ),
      section(
        'apps',
        'Apps and releases',
        <p>
          A project can contain several apps, such as a web app and a sync worker. Add an app
          attaches an existing app you own; it does not create a running app. The Apps tab appears
          with the second app. Releases and rollback move all member apps together, while each app
          keeps its own Overview and Settings. Pull requests opens the linked task for review.
        </p>,
      ),
      section(
        'app-settings',
        'App settings',
        <p>
          An app’s Overview shows its health and offers Open when it has an address. Settings shows
          its address, health check and computer, and lets you save a memory limit. Follow Project
          settings there to edit shared variables and secrets.
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
            Secrets are write-only: you can replace or delete one, but cannot reveal its saved
            value. Agents cannot read or change secrets. For apps using deploy.yaml, declare the
            names and references there. Older apps outside this configuration format still use their
            original per-app settings. See {docLink('deploy-yaml', 'deploy.yaml')}.
          </p>
        </>,
      ),
      section(
        'releases',
        'Keep releases and verify migrations',
        <p>
          In project Settings, Keep releases accepts 1–100 earlier releases, in addition to the
          current release; the default is five. Older entries keep their history and backup records
          but stop being rollback targets. Verify migrations starts on. Turning it off skips
          migration jobs on the verification copy; it still checks the apps and runs migrations
          during activation. Rollback data checks remain on.
        </p>,
      ),
      section(
        'remove',
        'Remove project',
        <p>
          Choose Remove project in Settings, review its apps and addresses, and type the project
          name to confirm. Removal stops its apps, frees their addresses and removes managed runtime
          data. Existing coordinator-local backups are retained for 30 days; it does not make a new
          backup. External mounted folders stay untouched. Backups held only on another computer
          remain there and are not included in the coordinator’s retained copies.
        </p>,
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
            Choose Back up now to run the configured coordinator backup as the administrator.
            Disabled backups or failed runs report an error. A saved record does not prove an
            external disk copy finished; keep another copy somewhere safe and check it.
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
            Choose Open the copy and sign in as its owner. Its private address looks like
            https://copy-&lt;restore-id&gt;.&lt;app&gt;.deploy.local and works on your home network.
            Check the restored data before switching.
          </li>
          <li>
            Choose I checked it · Switch when you want that data live. Cancel removes the unused
            copy.
          </li>
        </ol>,
      ),
      section(
        'private-copy',
        'The private copy address',
        <p>
          Only the restore owner can open a ready copy. Use Open the copy to pass your signed-in
          browser to that address. Signing out, removing the paired device, cancelling or switching
          the copy ends access. Copies support HTTP pages; WebSocket connections are disabled
          because the preview proxy does not support them.
        </p>,
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
      'Computers → Updates shows the coordinator release, each computer’s version and whether it can update.',
    sections: [
      section(
        'versions',
        'Check versions',
        <p>
          Open <a href="/dashboard/computers?updates=1">Computers → Updates</a>. A completed Live
          coordinator release can become the target for other computers. Missing version information
          stays unavailable. Failed updates show their reason; ready does not mean an update has
          finished.
        </p>,
      ),
      section(
        'automatic',
        'Auto-update computers',
        <>
          <p>
            An administrator can turn on Auto-update computers; it starts off. Every ten minutes,
            the coordinator checks for eligible Mac and Linux workers with supervised updates. A
            worker waits until tasks, app jobs, screen sessions and terminals are idle, then pauses
            new work while it updates.
          </p>
          <p>
            The downloaded build must match the verified Live coordinator release. The previous
            worker build is restored if startup fails, and new work waits until the installed
            version is confirmed. Failed updates remain visible and are not retried automatically.
          </p>
          <p>
            Older workers, Windows workers and desktop-managed workers cannot use this automatic
            path because they lack its supervised update protocol. Desktop and iPhone apps are
            updated on the device.
          </p>
        </>,
      ),
      section(
        'cli',
        'Update the CLI',
        <p>
          <code>deploy upgrade</code> downloads a verified CLI build from its configured coordinator
          and restores the previous binary if its version check fails. It does not update the
          coordinator or every computer. Check <code>deploy version</code> afterward. See{' '}
          {docLink('cli', 'CLI')}.
        </p>,
      ),
      section(
        'coordinator',
        'Release the coordinator',
        <>
          <p>
            Coordinator self-release needs a verified build bundle and an isolated verifier that
            checks real startup against a copy of its data. An external supervisor switches the
            coordinator, checks sustained startup and restores the previous build on failure. A
            repository branch or an app container alone is not a coordinator update.
          </p>
          <p>
            Ordinary builds cannot self-release because the build output does not include that
            bundle and verifier. Coordinator data migrations and mixed coordinator/app projects are
            also refused by this update path. The Restarting page means the coordinator is
            unavailable, not that an update succeeded.
          </p>
        </>,
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
        'your-agents',
        'Your agents',
        <>
          <p>
            There are no built-in agents. The Agents list in the sidebar starts empty, and each
            agent is one you create. Open an agent to read its conversation and its Background runs.
            Use its ⋯ menu for Tune, Approvals or Models.
          </p>
          <p>
            Tune saves its name, its job, the schedule, the project it works in, and its computers
            (blank means any computer that takes tasks, SER first). It links to Approvals and Models
            rather than keeping another copy of those settings. Delete, at the bottom of Tune,
            removes the agent with its schedule and approval rules. Tasks it already started stay in
            your task list.
          </p>
          <p>
            A run’s task shows Running as and the agent’s name (Ran as once it finishes), with a
            link to its Job. While a run is going, Run now waits: an agent does one run at a time.
          </p>
        </>,
      ),
      section(
        'new',
        'Add an agent',
        <ol>
          <li>
            Choose + next to Agents in the sidebar, or open{' '}
            <a href="/dashboard/agents/new">New agent</a>.
          </li>
          <li>
            Pick a template: Dependency watcher, Pull request reviewer, Check fixer, Issue triager
            or Release notes writer. Or describe your own job, and your connected model drafts it.
            Drafting needs a compatible model endpoint in{' '}
            <a href="/dashboard/computers/models">Computers › Models</a>.
          </li>
          <li>
            Review the name, instructions, schedule and Works in project. Edit anything unclear.
          </li>
          <li>Create the agent. Its actions start on Ask me.</li>
        </ol>,
      ),
      section(
        'background-runs',
        'Background runs',
        <>
          <p>
            Each agent has a schedule, such as Every morning at 08:00, on the coordinator’s clock.
            At that time it starts an ordinary task: its own folder, the project’s code checked out
            if Works in names a project, questions in Waiting on you, and a short report at the end.
            Each run sees the report from its previous run.
          </p>
          <p>
            The agent’s job is a setting, not a message. Every run, and any follow-up you send in
            its task, gets the job as standing instructions, so editing the job changes the next
            run. The task’s first message only says when and why it started.
          </p>
          <p>
            A scheduled start follows the agent’s Start a task rule in{' '}
            <a href="/dashboard/settings/approvals">Settings → Agents and approvals</a>. Ask me, the
            default, puts a question such as “Let Issue triager run now?” in Waiting on you, with
            Run and Skip today. Allowed starts the run unattended. Never skips it.
          </p>
          <p>
            Run now on the agent’s page starts a run straight away. It is your own start, so it does
            not ask first. Runs never merge, release or delete data.
          </p>
        </>,
      ),
      section(
        'mute-pause',
        'Mute or pause an agent',
        <p>
          On iPhone, open the agent menu. Mute for 1 hour silences that agent’s push notifications;
          Unmute ends it early. Pause blocks new agent conversation work and scheduled runs; Resume
          allows them again. Pausing does not stop task processes already running on a computer.
        </p>,
      ),
      section(
        'limits',
        'What runs today',
        <p>
          Agent chat can answer using a model, but has no tools. Scheduled runs and Run now start
          real tasks. Disk and mention triggers are saved but not active yet. Release health checks
          and rollback are deploy.local’s own, not an agent’s. Agents never start releases. See{' '}
          {docLink('approvals', 'Approvals')}.
        </p>,
      ),
    ],
  },
  {
    slug: 'approvals',
    title: 'Approvals',
    group: 'Agents',
    intro:
      'Agents start on Ask me. Review rules in one place, under Settings → Agents and approvals.',
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
          Rolling back after a failed release is deploy.local’s own check, with its own section,
          After a failed release. Its one rule, Roll back a release, is Ask me by default. Allowed
          rolls back automatically; Never blocks it. Project rollback rules still apply. Rollback
          checks these rules both when it is proposed and when it starts. A later Never rule blocks
          an older pending decision. A backup restore that loses newer data still needs your
          explicit confirmation.
        </p>,
      ),
      section(
        'matrix',
        'The agent actions',
        <>
          <p>
            The matrix has one column per agent you created and these four actions. With no agents
            yet, it links to New agent instead.
          </p>
          <ul>
            <li>Start a task</li>
            <li>Open a pull request</li>
            <li>Merge a pull request</li>
            <li>Restart an app</li>
          </ul>
          <p>
            On a narrow window the same choices stack into one group per agent. Start a task decides
            whether a scheduled run asks first, starts unattended or is skipped. Rules do not create
            the schedule; Tune does. The matrix does not add pull request, merge or restart
            execution to agent chat. Roll back a release is not in the matrix; it lives under After
            a failed release.
          </p>
        </>,
      ),
      section(
        'always-yours',
        'Always yours',
        <ul>
          <li>Use the screen asks for each task and one app at a time.</li>
          <li>Delete data or remove an app always asks.</li>
          <li>Read or change secrets is never available to agents.</li>
          <li>Start a release stays with you, even if a merge rule is Allowed.</li>
        </ul>,
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
          Save a default for Writing code, Reviewing and Answering questions here. The web and
          desktop composer uses Writing code for tasks and Answering questions for agent chat when
          no chat-specific model is selected. Reviewing is saved, but does not start an automatic
          review. These defaults have one settings page.
        </p>,
      ),
      section(
        'chat',
        'Choose for one chat',
        <p>
          A composer’s model choice belongs to that chat. It does not change the saved computer
          defaults. Choose Auto to use the job default. Agent drafting and chat require a compatible
          HTTP provider; a local CLI subscription alone does not connect that chat. An unsupported
          model choice reports an error instead of silently changing providers.
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
            This is the output of deploy --help. Except for deploy itself, run each listed command
            after deploy. Square brackets mark optional arguments; do not type the brackets.
          </p>
          {command(
            'deploy — ship and run apps on computers you own\n\nUsage  deploy [command] [app] [flags]\n\nShip\n  deploy                 Ship this folder to its project\n  plan [app]             Show what would change, without shipping\n  rollback [app]          Move a whole project back to its last release\n  releases [app]          List a project\'s releases\n\nWatch\n  status                 What is running, what is failing, what needs you\n  logs [app]             Stream logs (--build for the last build)\n  open [app]             Open the app in your browser\n  ssh [app]              Open a shell inside the app\n\nDecide\n  inbox                  Answer what is waiting on you\n                         inbox <id> <action> --yes to answer in scripts\n\nAgents\n  task "<what to do>"     Start a task (--on <computer>)\n  tasks                  Tasks and what they are doing\n\nApps and computers\n  discover [search]      Browse apps you can install\n  install <app>          Install an app from Discover\n  remove [app]           Remove an app (asks first)\n  computers              Computers and what each one is doing\n  computer join          Make this computer a worker\n\nAccount   login · logout · whoami · upgrade · version\n\nFlags    --json  machine output       -y, --yes  skip confirmations\n         -u, --url  coordinator       -h, --help help for any command\n\n[app] defaults to the project in this folder. More: deploy help advanced',
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
            the coordinator. <code>deploy login</code> opens browser approval; compare and approve
            its code. <code>deploy login --password</code> uses a password instead.
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
            Project uploads and rollback follow the recorded Prepare, Verify, Activate and Watch
            steps until the exact release finishes. Use <code>deploy logs [app] --build</code> to
            inspect build output. Older upload receipts without project steps label Verify and Watch
            skipped; the CLI does not invent those checks.
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
          Host mounts, external data and privileged apps cannot use isolated project verification.
          For supported apps, migration jobs without a reverse command require a pre-release backup.
          Review {docLink('releases', 'Releases and rollback')} before shipping data changes.
        </p>,
      ),
      section(
        'reverse',
        'Reversible migrations',
        <>
          <p>
            Put <code>release-migrations.json</code> beside the app source to register reverse
            commands for lifecycle jobs already declared in deploy.yaml. For a job named migrate:
          </p>
          {command('{"reverse":{"migrate":["migrate","down"]}}')}
          <p>
            Use the command your app actually provides. The release records it with the source;
            rollback runs it using the original image, settings and data volumes. Verify checks the
            target app on a copy, but does not rehearse the complete reverse-command chain.
          </p>
        </>,
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
          assigned computer when you change devices. App hosting is a separate capability. Project
          releases prepare and verify on each assigned computer before the coordinator publishes the
          complete project’s addresses. Saved progress lets release recovery continue after a
          restart.
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
            Startup recovery uses the saved progress to finish or undo an interrupted switch. An
            uncertain migration or restore keeps the project stopped and locked; keep its error and
            release ID for recovery. Do not delete records to force another attempt. Conflicting app
            changes remain blocked until the release or recovery finishes.
          </p>
        </>,
      ),
      section(
        'restore',
        'A restore copy will not open',
        <p>
          Use Open the copy from Backups while signed in as the restore owner, and check that the
          copy is ready. Its private home-network address stops working after Cancel, Switch,
          sign-out or device removal. WebSocket features are unavailable on preview copies. An
          unavailable restore explains its unsupported format or configuration; do not replace the
          copy check with an in-place restore.
        </p>,
      ),
      section(
        'model',
        'An agent cannot draft or reply',
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
