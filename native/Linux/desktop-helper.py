#!/usr/bin/python3
"""Session-local, view-only capture. No desktop access occurs until an inspect request."""
import base64
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import threading
import uuid

APP_ID = "local.deploy.DesktopHelper"
DEST = "org.freedesktop.portal.Desktop"
ROOT = "/org/freedesktop/portal/desktop"
CAST = "org.freedesktop.portal.ScreenCast"
MAX_REQUEST = 4096


def install_command():
    try:
        fedora = 'ID=fedora' in Path('/etc/os-release').read_text()
    except OSError:
        fedora = False
    if fedora:
        return "sudo dnf install python3-gobject gstreamer1 pipewire-gstreamer gstreamer1-plugins-base gstreamer1-plugins-good"
    return "sudo apt install python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good"


def session_type(env):
    # Never infer X11 from DISPLAY when running under Wayland/Xwayland.
    value = env.get('XDG_SESSION_TYPE', '').lower()
    return value if value in ('wayland', 'x11') else ('wayland' if env.get('WAYLAND_DISPLAY') else 'x11' if env.get('DISPLAY') else 'unknown')


def load_gi():
    import gi
    gi.require_version('Gst', '1.0')
    from gi.repository import Gio, GLib, Gst
    Gst.init(None)
    return Gio, GLib, Gst



def scaled_caps(size, width_limit=1280):
    """Raw video caps for a snapshot at most `width_limit` wide, keeping the screen's aspect ratio."""
    if size and len(size) == 2 and all(isinstance(v, int) and v > 0 for v in size):
        width, height = size
        target = min(width_limit, width)
        scaled = max(2, round(target * height / width) // 2 * 2)
        return f'video/x-raw,width={target},height={scaled},pixel-aspect-ratio=1/1'
    return f'video/x-raw,width=[1,{width_limit}],height=[1,{width_limit}],pixel-aspect-ratio=1/1'


def screen_lock(desktop, home=None, run=subprocess.run):
    """Whether the session locks itself when idle. Capture only sees the lock screen then."""
    try:
        if desktop == 'GNOME':
            def get(schema, key):
                return run(['gsettings', 'get', schema, key], capture_output=True, text=True,
                           timeout=2, check=True).stdout.strip()
            enabled = get('org.gnome.desktop.screensaver', 'lock-enabled') == 'true'
            idle = int(get('org.gnome.desktop.session', 'idle-delay').split()[-1])
            return dict(locks=enabled and idle > 0, idleSeconds=idle or None)
        if desktop == 'KDE':
            import configparser
            config = configparser.ConfigParser()
            config.read(Path(home or Path.home()) / '.config/kscreenlockerrc')
            daemon = config['Daemon'] if config.has_section('Daemon') else {}
            enabled = str(daemon.get('Autolock', 'true')).lower() != 'false'
            minutes = int(daemon.get('Timeout', '5'))
            return dict(locks=enabled and minutes > 0, idleSeconds=minutes * 60 or None)
    except Exception:
        pass
    return dict(locks=None, idleSeconds=None)


def lock_notice(lock):
    if not lock.get('locks'):
        return ''
    minutes = round((lock.get('idleSeconds') or 0) / 60)
    after = f' after {minutes} minute{"s" if minutes != 1 else ""} idle' if minutes else ' when idle'
    return f' The screen locks{after}, and captures show nothing while it is locked.'

class TokenStore:
    def __init__(self, path):
        self.path = Path(path)

    def read(self):
        try:
            value = json.loads(self.path.read_text()).get('restore_token')
            return value if isinstance(value, str) and value else None
        except (OSError, ValueError, AttributeError):
            return None

    def write(self, token):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump({'restore_token': token}, output)
        os.replace(temporary, self.path)


class Portal:
    def __init__(self, gio, glib):
        self.Gio, self.GLib = gio, glib
        # A private connection gives every capture a fresh host registration, including
        # after portal restarts. Register must precede all other portal calls.
        address = gio.dbus_address_get_for_bus_sync(gio.BusType.SESSION, None)
        self.bus = gio.DBusConnection.new_for_address_sync(
            address, gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
        self.session = None
        try:
            self.call('org.freedesktop.host.portal.Registry', 'Register', '(sa{sv})', (APP_ID, {}))
        except Exception:
            self.close()
            raise

    def call(self, interface, method, signature, args, path=ROOT, destination=DEST):
        return self.bus.call_sync(destination, path, interface, method,
                                  self.GLib.Variant(signature, args), None,
                                  self.Gio.DBusCallFlags.NONE, 5000, None).unpack()

    def version(self):
        value = self.call('org.freedesktop.DBus.Properties', 'Get', '(ss)', (CAST, 'version'))[0]
        return value.unpack() if hasattr(value, 'unpack') else value

    def request(self, method, signature, args):
        token = 'deploy_' + uuid.uuid4().hex
        args[-1]['handle_token'] = self.GLib.Variant('s', token)
        sender = self.bus.get_unique_name().lstrip(':').replace('.', '_')
        path = ROOT + '/request/' + sender + '/' + token
        done, result = threading.Event(), []

        def response(_connection, _sender, _path, _interface, _signal, parameters):
            result.extend(parameters.unpack())
            done.set()

        subscription = self.bus.signal_subscribe(DEST, 'org.freedesktop.portal.Request', 'Response', path, None,
                                                  self.Gio.DBusSignalFlags.NONE, response)
        try:
            returned = self.call(CAST, method, signature, tuple(args))[0]
            if returned != path:
                raise RuntimeError('Portal returned an unexpected request handle')
            if not done.wait(110 if method == 'Start' else 10):
                self.call('org.freedesktop.portal.Request', 'Close', '()', (), path=path)
                raise RuntimeError('Screen sharing approval timed out; approve on this computer’s screen')
            if result[0] != 0:
                raise RuntimeError('Screen sharing was cancelled or denied on this computer')
            return result[1]
        finally:
            self.bus.signal_unsubscribe(subscription)

    def start(self, store):
        variant = self.GLib.Variant
        created = self.request('CreateSession', '(a{sv})', [
            {'session_handle_token': variant('s', 'deploy_' + uuid.uuid4().hex)}])
        self.session = created['session_handle']
        options = {'types': variant('u', 1), 'multiple': variant('b', False), 'persist_mode': variant('u', 2)}
        token = store.read()
        if token:
            # Restore tokens are single-use. Never retry a consumed token.
            store.write(None)
            options['restore_token'] = variant('s', token)
        self.request('SelectSources', '(oa{sv})', [self.session, options])
        started = self.request('Start', '(osa{sv})', [self.session, '', {}])
        store.write(started.get('restore_token'))
        streams = started.get('streams', [])
        if len(streams) != 1:
            raise RuntimeError('Select one monitor to share')
        reply, descriptors = self.bus.call_with_unix_fd_list_sync(
            DEST, ROOT, CAST, 'OpenPipeWireRemote', variant('(oa{sv})', (self.session, {})),
            None, self.Gio.DBusCallFlags.NONE, 5000, None, None)
        return descriptors.get(reply.unpack()[0]), streams[0]

    def close(self):
        if self.session:
            try:
                self.call('org.freedesktop.portal.Session', 'Close', '()', (), path=self.session)
            except Exception:
                pass
        try:
            self.bus.close_sync(None)
        except Exception:
            pass


class Desktop:
    def __init__(self, path, env=None, gi_loader=load_gi, portal_factory=Portal, store=None):
        self.path = str(path)
        self.env = os.environ if env is None else env
        self.loader, self.portal_factory = gi_loader, portal_factory
        self.store = store or TokenStore(Path(self.env.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'deploy/desktop-restore.json')
        self.capture_lock = threading.Lock()
        self.lock_settings = lambda kind: screen_lock(kind)

    def status(self):
        kind = session_type(self.env)
        raw_desktop = self.env.get('XDG_CURRENT_DESKTOP', '')
        desktop = 'GNOME' if 'gnome' in raw_desktop.lower() else 'KDE' if 'kde' in raw_desktop.lower() else raw_desktop or 'unknown'
        result = dict(sessionType=kind, desktop=desktop, portalAvailable=None,
                      grantStored=bool(self.store.read()) if kind == 'wayland' else None,
                      socketPath=self.path, available=False, viewOnly=True,
                      screenLock=self.lock_settings(desktop))
        try:
            if kind == 'unknown':
                raise RuntimeError('No graphical session environment; log out and back in, then check the user service environment')
            gio, glib, gst = self.loader()
            required = ['videoconvert', 'videoscale', 'jpegenc', 'appsink', 'pipewiresrc' if kind == 'wayland' else 'ximagesrc']
            missing = [name for name in required if not gst.ElementFactory.find(name)]
            if missing:
                raise RuntimeError('Missing GStreamer elements: ' + ', '.join(missing) + '. Install: ' + install_command())
            if kind == 'wayland':
                portal = self.portal_factory(gio, glib)
                try:
                    version = portal.version()
                    result['portalAvailable'] = True
                    result['portalVersion'] = version
                    if version < 4:
                        raise RuntimeError('ScreenCast portal version 4 or newer is required for persistent grants')
                finally:
                    portal.close()
            result['available'] = True
            result['reason'] = ('Approve screen sharing on ' + socket.gethostname() + '’s screen once.' if kind == 'wayland' and not result['grantStored'] else 'Desktop capture is view-only.') + lock_notice(result['screenLock'])
        except (ImportError, ValueError) as error:
            result['reason'] = str(error) + '. Install: ' + install_command()
        except Exception as error:
            result['reason'] = str(error)
        return result

    def screen_state(self, gio, glib):
        try:
            bus = gio.bus_get_sync(gio.BusType.SESSION, None)
        except Exception:
            return None
        for destination, path, interface in [
                ('org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver'),
                ('org.freedesktop.ScreenSaver', '/ScreenSaver', 'org.freedesktop.ScreenSaver')]:
            try:
                active = bus.call_sync(destination, path, interface, 'GetActive', None, None,
                                       gio.DBusCallFlags.NO_AUTO_START, 1000, None).unpack()[0]
                if active:
                    return ('The desktop is locked or idle. Unlock and wake the screen before capturing, or run '
                            '`deploy desktop-helper screen-lock off` on this computer to keep it unlocked.')
            except Exception:
                pass
        return None

    def frame(self, gst, fd=None, stream=None):
        # Fix both dimensions: PipeWire offers a height range, and fixing only the width let
        # GStreamer pick the largest height (32767), a stretched multi-megabyte frame.
        source = gst.ElementFactory.make('pipewiresrc' if fd is not None else 'ximagesrc', 'source')
        container = gst.Pipeline.new(None)
        elements = [source] + [gst.ElementFactory.make(name, None) for name in
                               ('videoconvert', 'videoscale', 'capsfilter', 'jpegenc', 'appsink')]
        elements[3].set_property('caps', gst.Caps.from_string(scaled_caps(stream[1].get('size') if stream else None)))
        elements[4].set_property('quality', 55)
        sinkpad = elements[5]
        for name, value in [('sync', False), ('max-buffers', 1), ('drop', True)]:
            sinkpad.set_property(name, value)
        for element in elements:
            container.add(element)
        for left, right in zip(elements, elements[1:]):
            if not left.link(right):
                raise RuntimeError('Could not link desktop capture pipeline')
        if fd is not None:
            source.set_property('fd', fd)
            serial = stream[1].get('pipewire-serial')
            if serial and source.find_property('target-object'):
                source.set_property('target-object', str(serial))
            else:
                source.set_property('path', str(stream[0]))
        else:
            source.set_property('use-damage', False)
        try:
            container.set_state(gst.State.PLAYING)
            sample = sinkpad.emit('try-pull-sample', 8 * gst.SECOND)
            if not sample:
                message = container.get_bus().pop_filtered(gst.MessageType.ERROR)
                detail = str(message.parse_error()[0]) if message else 'No desktop frame; the screen may be locked or idle'
                raise RuntimeError(detail)
            buffer = sample.get_buffer()
            image = buffer.extract_dup(0, buffer.get_size())
            if len(image) > 1000000:
                raise RuntimeError('Desktop frame exceeds the snapshot size limit')
            caps = sample.get_caps().get_structure(0)
            return dict(image=base64.b64encode(image).decode('ascii'), mimeType='image/jpeg',
                        width=caps.get_value('width'), height=caps.get_value('height'), text='Desktop screenshot (view-only)')
        finally:
            container.set_state(gst.State.NULL)

    def inspect(self):
        if not self.capture_lock.acquire(blocking=False):
            raise RuntimeError('A desktop capture is already in progress')
        portal, fd = None, None
        try:
            status = self.status()
            if not status['available']:
                raise RuntimeError(status['reason'])
            gio, glib, gst = self.loader()
            state = self.screen_state(gio, glib)
            if state:
                return dict(text=state, screenState='locked-or-idle')
            try:
                if status['sessionType'] == 'wayland':
                    portal = self.portal_factory(gio, glib)
                    fd, stream = portal.start(self.store)
                    result = self.frame(gst, fd, stream)
                else:
                    result = self.frame(gst)
            except Exception:
                state = self.screen_state(gio, glib)
                if state:
                    return dict(text=state, screenState='locked-or-idle')
                raise
            state = self.screen_state(gio, glib)
            return dict(text=state, screenState='locked-or-idle') if state else result
        finally:
            if fd is not None:
                os.close(fd)
            if portal:
                portal.close()
            self.capture_lock.release()


def dispatch(request, desktop):
    if not isinstance(request, dict) or set(request) != {'type'}:
        raise ValueError('Expected one JSON object with only type: status or inspect')
    if request['type'] == 'status':
        return desktop.status()
    if request['type'] == 'inspect':
        return desktop.inspect()
    raise ValueError('Linux desktops are view-only; only inspect is supported')


def peer_uid(connection):
    return struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))[1]


def serve_connection(connection, desktop, uid, credentials=peer_uid):
    try:
        if credentials(connection) != uid:
            raise PermissionError('Desktop helper requires a peer with the same uid')
        connection.settimeout(5)
        data = bytearray()
        while b'\n' not in data:
            part = connection.recv(1024)
            if not part:
                raise ValueError('Expected a newline-terminated JSON request')
            data.extend(part)
            if len(data) > MAX_REQUEST:
                raise ValueError('Desktop request too large')
        if data.count(b'\n') != 1 or not data.endswith(b'\n'):
            raise ValueError('Only one request is allowed per connection')
        result = dispatch(json.loads(data), desktop)
    except Exception as error:
        result = {'error': str(error)}
    connection.sendall((json.dumps(result) + '\n').encode())


def main():
    if os.getuid() == 0:
        raise SystemExit('Run the desktop helper as the logged-in user, never root')
    runtime = Path(os.environ['XDG_RUNTIME_DIR'])
    info = runtime.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SystemExit('XDG_RUNTIME_DIR must be private and owned by this user')
    os.umask(0o077)
    path = runtime / 'deploy-desktop.sock'
    lock = open(runtime / 'deploy-desktop.lock', 'w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if path.exists():
        info = path.lstat()
        if info.st_uid != os.getuid() or not stat.S_ISSOCK(info.st_mode):
            raise SystemExit('Refusing to replace a foreign or non-socket path')
        path.unlink()
    desktop = Desktop(path)

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            serve_connection(self.request, desktop, os.getuid())

    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True

    server = Server(str(path), Handler)
    os.chmod(path, 0o600)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        # Signals from portal requests are dispatched here, while socket threads wait.
        try:
            from gi.repository import GLib
        except ImportError:
            # Keep status available so the worker can show the package install command.
            stopped = threading.Event()
            for number in (signal.SIGTERM, signal.SIGINT):
                signal.signal(number, lambda *_: stopped.set())
            stopped.wait()
        else:
            loop = GLib.MainLoop()
            for number in (signal.SIGTERM, signal.SIGINT):
                GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, number, lambda: (loop.quit(), False)[1])
            loop.run()
    finally:
        server.shutdown()
        server.server_close()
        path.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
