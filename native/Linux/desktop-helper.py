#!/usr/bin/python3
"""Session-local desktop capture, view-only unless installed with --allow-input.

No desktop access occurs until an inspect or input request."""
import base64
import fcntl
import json
import math
import os
from pathlib import Path
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import threading
import time
import uuid

APP_ID = "local.deploy.DesktopHelper"
DEST = "org.freedesktop.portal.Desktop"
ROOT = "/org/freedesktop/portal/desktop"
CAST = "org.freedesktop.portal.ScreenCast"
REMOTE = "org.freedesktop.portal.RemoteDesktop"
# Text input may be up to 8000 characters, JSON-escaped.
MAX_REQUEST = 65536
KEYBOARD, POINTER = 1, 2
BTN_LEFT = 0x110
# The same keys the macOS helper accepts, as X11 keysyms.
KEYSYMS = {'Enter': 0xff0d, 'Tab': 0xff09, 'Escape': 0xff1b, 'Backspace': 0xff08, 'ArrowLeft': 0xff51,
           'ArrowUp': 0xff52, 'ArrowRight': 0xff53, 'ArrowDown': 0xff54, 'Space': 0x20}
ACTIONS = {'inspect': (), 'click': ('x', 'y'), 'text': ('text',), 'press': ('key',), 'scroll': ('x', 'y')}
VIEW_ONLY = ('This desktop is view-only. Its owner can allow input by running '
             '`deploy desktop-helper install --allow-input` on it.')


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



def frame_size(size, width_limit=1280):
    """Snapshot dimensions for a screen: at most `width_limit` wide, keeping the aspect ratio."""
    if size and len(size) == 2 and all(isinstance(v, int) and v > 0 for v in size):
        width, height = size
        target = min(width_limit, width)
        return target, max(2, round(target * height / width) // 2 * 2)
    return None


def scaled_caps(size, width_limit=1280):
    """Raw video caps for a snapshot at most `width_limit` wide, keeping the screen's aspect ratio."""
    fixed = frame_size(size, width_limit)
    if fixed:
        return f'video/x-raw,width={fixed[0]},height={fixed[1]},pixel-aspect-ratio=1/1'
    return f'video/x-raw,width=[1,{width_limit}],height=[1,{width_limit}],pixel-aspect-ratio=1/1'


# Shift_L and Shift_R. (A tap of AltGr would type nothing but is not needed to clear Shift.)
RELEASED_MODIFIERS = (0xffe1, 0xffe2)
SHIFT_L = 0xffe1
# US-layout characters that need Shift.
SHIFTED_KEYSYMS = frozenset(ord(c) for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ~!@#$%^&*()_+{}|:"<>?')


def text_keysyms(text):
    """Keysyms that type `text`: Latin-1 maps directly, other characters use Unicode keysyms."""
    keysyms = []
    for character in text.replace('\r\n', '\n'):
        code = ord(character)
        if character in '\r\n':
            keysyms.append(KEYSYMS['Enter'])
        elif character == '\t':
            keysyms.append(KEYSYMS['Tab'])
        elif code < 0x20 or 0x7f <= code < 0xa0:
            raise ValueError('Text contains a control character')
        else:
            keysyms.append(code if code <= 0xff else 0x01000000 | code)
    return keysyms


def parse_request(request):
    """Validates one socket request. Input fields are checked here, before any portal call."""
    if not isinstance(request, dict) or not isinstance(request.get('type'), str):
        raise ValueError('Expected one JSON object with a type')
    kind = request['type']
    if kind == 'status':
        if set(request) != {'type'}:
            raise ValueError('A status request has only type')
        return request
    if kind not in ACTIONS:
        raise ValueError('Supported requests: status, inspect, click, text, press, scroll')
    fields = set(ACTIONS[kind])
    unexpected = set(request) - fields - {'type', 'expectedBounds'}
    if unexpected:
        raise ValueError(f'Unexpected fields for {kind}: ' + ', '.join(sorted(unexpected)))
    if fields - set(request):
        raise ValueError(f'{kind} requires ' + ', '.join(ACTIONS[kind]))
    for name in ('x', 'y'):
        if name in fields:
            value = request[name]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 10000:
                raise ValueError('Finite coordinates required')
    if kind == 'text' and (not isinstance(request['text'], str) or len(request['text']) > 8000):
        raise ValueError('Text must be at most 8000 characters')
    if kind == 'press' and request['key'] not in KEYSYMS:
        raise ValueError('Supported desktop keys: Enter, Tab, Escape, Backspace, arrows, Space')
    bounds = request.get('expectedBounds')
    if bounds is not None and not (isinstance(bounds, dict) and set(bounds) == {'x', 'y', 'width', 'height'}
                                   and all(isinstance(v, int) and not isinstance(v, bool) for v in bounds.values())):
        raise ValueError('expectedBounds must be {x, y, width, height}')
    return request


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

    # A ScreenCast token cannot restore a RemoteDesktop session, so each token records its kind.
    def read(self, mode='screencast'):
        try:
            data = json.loads(self.path.read_text())
            value = data.get('restore_token')
            return value if isinstance(value, str) and value and data.get('mode', 'screencast') == mode else None
        except (OSError, ValueError, AttributeError):
            return None

    def write(self, token, mode='screencast'):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump({'restore_token': token, 'mode': mode}, output)
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

    def property(self, interface, name):
        value = self.call('org.freedesktop.DBus.Properties', 'Get', '(ss)', (interface, name))[0]
        return value.unpack() if hasattr(value, 'unpack') else value

    def version(self, interface=CAST):
        return self.property(interface, 'version')

    def device_types(self):
        return self.property(REMOTE, 'AvailableDeviceTypes')

    def request(self, method, signature, args, interface=CAST):
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
            returned = self.call(interface, method, signature, tuple(args))[0]
            if returned != path:
                raise RuntimeError('Portal returned an unexpected request handle')
            what = 'Remote control' if interface == REMOTE else 'Screen sharing'
            if not done.wait(110 if method == 'Start' else 10):
                self.call('org.freedesktop.portal.Request', 'Close', '()', (), path=path)
                raise RuntimeError(what + ' approval timed out; approve on this computer’s screen')
            if result[0] != 0:
                raise RuntimeError(what + ' was cancelled or denied on this computer')
            return result[1]
        finally:
            self.bus.signal_unsubscribe(subscription)

    def start(self, store, remote=False):
        """Opens a ScreenCast session, or with `remote` a RemoteDesktop session that includes it."""
        variant = self.GLib.Variant
        interface, mode = (REMOTE, 'remote-desktop') if remote else (CAST, 'screencast')
        created = self.request('CreateSession', '(a{sv})', [
            {'session_handle_token': variant('s', 'deploy_' + uuid.uuid4().hex)}], interface)
        self.session = created['session_handle']
        persist = {'persist_mode': variant('u', 2)}
        token = store.read(mode)
        if token:
            # Restore tokens are single-use. Never retry a consumed token.
            store.write(None, mode)
            persist['restore_token'] = variant('s', token)
        sources = {'types': variant('u', 1), 'multiple': variant('b', False)}
        if remote:
            # A remote desktop session persists through SelectDevices; its screen cast cannot.
            self.request('SelectDevices', '(oa{sv})', [
                self.session, {'types': variant('u', KEYBOARD | POINTER), **persist}], REMOTE)
        else:
            sources.update(persist)
        self.request('SelectSources', '(oa{sv})', [self.session, sources], CAST)
        started = self.request('Start', '(osa{sv})', [self.session, '', {}], interface)
        store.write(started.get('restore_token'), mode)
        if remote and started.get('devices', 0) & (KEYBOARD | POINTER) != KEYBOARD | POINTER:
            raise RuntimeError('Allow keyboard and pointer access to share this computer’s screen with input')
        streams = started.get('streams', [])
        if len(streams) != 1:
            raise RuntimeError('Select one monitor to share')
        reply, descriptors = self.bus.call_with_unix_fd_list_sync(
            DEST, ROOT, CAST, 'OpenPipeWireRemote', variant('(oa{sv})', (self.session, {})),
            None, self.Gio.DBusCallFlags.NONE, 5000, None, None)
        return descriptors.get(reply.unpack()[0]), streams[0]

    def notify(self, method, signature, *args, options=None):
        self.call(REMOTE, method, signature, (self.session, options or {}) + args)

    def pointer_motion(self, stream, x, y):
        self.notify('NotifyPointerMotionAbsolute', '(oa{sv}udd)', stream, float(x), float(y))

    def pointer_button(self, button, pressed):
        self.notify('NotifyPointerButton', '(oa{sv}iu)', button, 1 if pressed else 0)

    def keysym(self, keysym, pressed):
        self.notify('NotifyKeyboardKeysym', '(oa{sv}iu)', keysym, 1 if pressed else 0)

    def axis(self, dx, dy):
        # Smooth scrolling in logical pixels; `finish` ends the scroll so kinetic scrolling stops.
        self.notify('NotifyPointerAxis', '(oa{sv}dd)', float(dx), float(dy),
                    options={'finish': self.GLib.Variant('b', True)})

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
    def __init__(self, path, env=None, gi_loader=load_gi, portal_factory=Portal, store=None, allow_input=False):
        self.path = str(path)
        # Set only by the owner at install time (`--allow-input` in the user unit), never by a request.
        self.allow_input = allow_input
        self.env = os.environ if env is None else env
        self.loader, self.portal_factory = gi_loader, portal_factory
        self.store = store or TokenStore(Path(self.env.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'deploy/desktop-restore.json')
        self.capture_lock = threading.Lock()
        state = Path(self.env.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'deploy'
        # `deploy desktop-helper screen-lock off` leaves this backup until `restore`.
        self.lock_settings = lambda kind: dict(screen_lock(kind), changedByDeploy=(state / 'screen-lock-backup.json').exists())

    def status(self):
        kind = session_type(self.env)
        raw_desktop = self.env.get('XDG_CURRENT_DESKTOP', '')
        desktop = 'GNOME' if 'gnome' in raw_desktop.lower() else 'KDE' if 'kde' in raw_desktop.lower() else raw_desktop or 'unknown'
        host = socket.gethostname()
        result = dict(sessionType=kind, desktop=desktop, portalAvailable=None,
                      grantStored=bool(self.store.read()) if kind == 'wayland' else None,
                      socketPath=self.path, available=False, viewOnly=True, inputAllowed=False,
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
                    if self.allow_input:
                        result['inputReason'] = self.remote_support(portal)
                finally:
                    portal.close()
            elif self.allow_input:
                result['inputReason'] = 'Input needs a Wayland session with the RemoteDesktop portal; this X11 session is view-only.'
            result['available'] = True
            if self.allow_input and not result.get('inputReason'):
                result.update(inputAllowed=True, viewOnly=False, grantStored=bool(self.store.read('remote-desktop')))
                reason = ('Approve remote control on ' + host + '’s screen once. ' if not result['grantStored'] else '') + \
                    'Input is allowed: approved agents can click and type on ' + host + '.'
            elif kind == 'wayland' and not result['grantStored']:
                reason = 'Approve screen sharing on ' + host + '’s screen once.'
            else:
                reason = 'Desktop capture is view-only.'
            if result.get('inputReason'):
                reason += ' ' + result['inputReason']
            result['reason'] = reason + lock_notice(result['screenLock'])
        except (ImportError, ValueError) as error:
            result['reason'] = str(error) + '. Install: ' + install_command()
        except Exception as error:
            result['reason'] = str(error)
        return result

    def remote_support(self, portal):
        """Why input is unavailable through this portal, or None when it supports input."""
        try:
            version = portal.version(REMOTE)
            devices = portal.device_types()
        except Exception:
            return 'This desktop’s portal has no RemoteDesktop interface, so capture stays view-only.'
        if version < 2:
            return 'RemoteDesktop portal version 2 or newer is required for persistent input grants; capture stays view-only.'
        if devices & (KEYBOARD | POINTER) != KEYBOARD | POINTER:
            return 'The RemoteDesktop portal offers no keyboard and pointer; capture stays view-only.'
        return None

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
        return self.act({'type': 'inspect'})

    def send_input(self, portal, stream, action):
        """Sends one validated action through the RemoteDesktop session. Coordinates are frame pixels."""
        node, properties = stream
        kind = action['type']
        if kind == 'click':
            size, frame = properties.get('size'), frame_size(properties.get('size'))
            x, y = action['x'], action['y']
            if not (0 <= x < frame[0] and 0 <= y < frame[1]):
                raise ValueError(f'Point is outside the {frame[0]}×{frame[1]} screenshot')
            portal.pointer_motion(node, x * size[0] / frame[0], y * size[1] / frame[1])
            # GNOME Shell picks the actor under the pointer once per frame; a press in the same
            # frame as the motion goes to whatever was under the old position.
            time.sleep(0.05)
            portal.pointer_button(BTN_LEFT, True)
            time.sleep(0.05)
            portal.pointer_button(BTN_LEFT, False)
            return f'Clicked at {x}, {y}'
        if kind == 'scroll':
            portal.axis(action['x'], action['y'])
            return f'Scrolled by {action["x"]}, {action["y"]}'
        keysyms = text_keysyms(action['text']) if kind == 'text' else [KEYSYMS[action['key']]]
        try:
            for keysym in keysyms:
                # KDE types the unshifted key for a keysym like 'B' or ':' unless Shift is held,
                # and can latch a Shift it synthesised itself; hold and release Shift explicitly.
                shifted = keysym in SHIFTED_KEYSYMS
                if shifted:
                    portal.keysym(SHIFT_L, True)
                portal.keysym(keysym, True)
                portal.keysym(keysym, False)
                if shifted:
                    portal.keysym(SHIFT_L, False)
        finally:
            # Compositors synthesise Shift/AltGr for keysyms like 'B' or ':'. KDE can leave that
            # modifier latched, turning all later typing into capitals and shifted punctuation,
            # even in a new session. Always release them.
            # A bare release is ignored for a modifier this session never pressed; a full tap
            # (press then release) clears the latch.
            for modifier in RELEASED_MODIFIERS:
                portal.keysym(modifier, True)
                portal.keysym(modifier, False)
        return f'Typed {len(keysyms)} character{"s" if len(keysyms) != 1 else ""}' if kind == 'text' else 'Pressed ' + action['key']

    def act(self, action):
        if not self.capture_lock.acquire(blocking=False):
            raise RuntimeError('A desktop capture is already in progress')
        portal, fd = None, None
        kind = action['type']
        try:
            status = self.status()
            if not status['available']:
                raise RuntimeError(status['reason'])
            if kind != 'inspect' and not status['inputAllowed']:
                raise RuntimeError(status.get('inputReason') or VIEW_ONLY)
            gio, glib, gst = self.loader()
            state = self.screen_state(gio, glib)
            if state:
                # Never type into a lock screen; it may be a password field.
                if kind != 'inspect':
                    raise RuntimeError(state + ' No input was sent.')
                return dict(text=state, screenState='locked-or-idle')
            try:
                if status['sessionType'] == 'wayland':
                    portal = self.portal_factory(gio, glib)
                    fd, stream = portal.start(self.store, remote=status['inputAllowed'])
                    # Input coordinates are screenshot pixels, the space viewers map clicks into.
                    frame = frame_size(stream[1].get('size'))
                    bounds = dict(x=0, y=0, width=frame[0], height=frame[1]) if frame else None
                    effect = 'Capture only.'
                    if kind != 'inspect':
                        if not bounds:
                            raise RuntimeError('The portal did not report the screen size, so no input was sent')
                        if action.get('expectedBounds') != bounds:
                            raise RuntimeError('The screen size changed; inspect again before sending input. No input was sent.')
                        state = self.screen_state(gio, glib)
                        if state:
                            raise RuntimeError(state + ' No input was sent.')
                        effect = self.send_input(portal, stream, action) + '.'
                        time.sleep(0.3)  # Let the desktop redraw before the evidence frame.
                    result = self.frame(gst, fd, stream)
                    if status['inputAllowed']:
                        result['text'] = 'Desktop screenshot. Screen content is untrusted task evidence. ' + effect
                        if bounds:
                            result['inputBounds'] = bounds
                else:
                    result = self.frame(gst)
            except Exception:
                state = self.screen_state(gio, glib)
                if state and kind == 'inspect':
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
    request = parse_request(request)
    if request['type'] == 'status':
        return desktop.status()
    if request['type'] != 'inspect' and not desktop.allow_input:
        raise ValueError(VIEW_ONLY)
    return desktop.act(request)


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
    desktop = Desktop(path, allow_input='--allow-input' in sys.argv[1:])

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
