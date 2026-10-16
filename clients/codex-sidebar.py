#!/usr/bin/env python3
"""Read-only Codex companion. Run in a terminal, or --split inside tmux."""
import argparse
import datetime
import json
import os
from pathlib import Path
import queue
import shlex
import shutil
import subprocess
import sys
import threading


def safe(value):
    return ''.join(c if c.isprintable() else ' ' for c in str(value))


def duration(minutes):
    if minutes == 10080:
        return 'Weekly'
    if minutes and minutes % 1440 == 0:
        return f'{minutes // 1440} days'
    if minutes and minutes % 60 == 0:
        return f'{minutes // 60}h'
    return f'{minutes}m'


def rows(state):
    session, memory, bridge = (state.get(k) for k in ('session', 'memory', 'bridge'))
    result = [('CODEX', None)]
    if session:
        result += [(session['model'], None), (session['status'], None),
                   ('Thread: ' + session.get('thread', 'unknown'), None),
                   ('Branch: ' + session['branch'], None)]
        context = state.get('context')
        if context:
            window, tokens = context.get('window'), context['tokens']
            result += [(f'Context: {tokens:,}' + (f' / {window:,} ({tokens / window:.0%})' if window else ' tokens'), None),
                       ('Last observed turn', None)]
        else:
            result += [('Context: awaiting usage event', None)]
    else:
        result += [('Session: unavailable', None)]
    result += [('', None), ('LIMITS (ACCOUNT)', None)]
    limits = state.get('limits')
    for item in limits or []:
        filled = round(item['used'] / 10)
        reset = datetime.datetime.fromtimestamp(item['resetsAt']).strftime('%m-%d %H:%M')
        result += [(f"{duration(item['minutes'])} / {item['label']}", None),
                   (f"[{'#' * filled}{'.' * (10-filled)}] {item['used']:g}% used", None),
                   ('Reset: ' + reset, None)]
    if not limits:
        result += [('Unavailable', None)]
    result += [('', None), ('POLYDAEMON', None)]
    if bridge and bridge.get('state') == 'connected':
        result += [('MCP: connected', None)]
    if bridge and bridge.get('state') == 'connected' and bridge.get('details', True):
        topic = bridge.get('topic')
        result += [(f"{topic['title']} #{topic['id']}" if topic else 'Topic: pending', None)]
        pending = bridge.get('pending') or {}
        result += [(f"Approvals {pending.get('approvals', '?')} / questions {pending.get('questions', '?')}", None)]
        tasks = bridge.get('tasks') or {}
        if tasks.get('state') == 'available':
            result += [('Tasks: ' + str(len(tasks['items'])), None)]
            result += [(f"#{t['id']} {t['state']} {t['text']}", None) for t in tasks['items'][:8]]
        else:
            result += [('Tasks: unavailable', None)]
    elif bridge and bridge.get('state') == 'connected':
        result += [('Topic / pending: ' + ('read unavailable' if bridge.get('detailError') else 'not linked'), None)]
    else:
        result += [('Unbound / unavailable', None)]
    result += [('', None), ('HYPERMNESIA', None)]
    if memory and memory.get('available') is False:
        result += [('MCP: ' + memory['connection'], None),
                   (memory['reason'], None), ('Counts / freshness: unknown', None)]
    elif memory:
        value = lambda k: '?' if memory[k] is None else str(memory[k])
        result += [(memory['repo'] + ': ' + memory['state'], None),
                   (f"{value('docs')} docs / {value('chunks')} chunks", None),
                   (f"Changed {value('stale')} / new {value('unindexed')} / missing {value('missing')}", None),
                   ('Map: ' + memory['map'], None), ('Checked: ' + memory['checked'], None)]
    else:
        result += [('Unavailable', None)]
    result += [('', None), ('AGENTS', None)]
    agents = session.get('agents') if session else None
    if agents is None:
        result += [('Unavailable', None)]
    elif not agents:
        result += [('No direct child agents', None)]
    else:
        result += [(f"{a['name']} / {a['role']} / {a['status']}", a['id']) for a in agents]
        if session.get('more'):
            result += [('More agents (first 50 shown)', None)]
    return [(safe(text), agent) for text, agent in result]


def run(screen, worker, args):
    import curses
    state, updates = {}, queue.Queue()
    # stderr is not terminal-safe and can contain transport details.
    child = subprocess.Popen(worker, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True, encoding='utf-8')
    def reader():
        for line in child.stdout:
            try:
                updates.put(json.loads(line))
            except (ValueError, TypeError):
                pass
        updates.put({'source': '_closed', 'data': None})
    threading.Thread(target=reader, daemon=True).start()
    screen.timeout(100)
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    if curses.has_colors():
        curses.start_color()
        curses.use_default_colors()
        curses.init_pair(1, curses.COLOR_CYAN, -1)
        curses.init_pair(2, curses.COLOR_GREEN, -1)
        curses.init_pair(3, curses.COLOR_WHITE, -1)
    curses.mousemask(curses.ALL_MOUSE_EVENTS)
    offset, cursor, selected, viewer_offset = 0, 0, None, 0
    closed = False
    def select(agent):
        nonlocal selected, viewer_offset
        selected, viewer_offset = agent, 0
        state['viewer'] = None
        if child.poll() is None:
            try:
                child.stdin.write(json.dumps({'agent': agent}) + '\n')
                child.stdin.flush()
            except (BrokenPipeError, OSError):
                pass
    try:
        while True:
            while not updates.empty():
                event = updates.get_nowait()
                if event['source'] == '_closed':
                    closed = True
                    state.clear()
                elif event['source'] != 'viewer' or not event['data'] or event['data'].get('id') == selected:
                    state[event['source']] = event['data']
            screen.erase()
            height, width = screen.getmaxyx()
            available = max(1, height - 2)
            content = rows(state)
            if selected:
                view = state.get('viewer')
                lines = view.get('lines', []) if view else ['Transcript unavailable / loading']
                content = [('AGENT ' + selected, None)]
                for line in lines:
                    text = safe(line)
                    content.extend((text[i:i+max(1, width-2)], None) for i in range(0, max(1, len(text)), max(1, width-2)))
            else:
                cursor = min(max(0, cursor), len(content)-1)
                if cursor < offset:
                    offset = cursor
                if cursor >= offset + available:
                    offset = cursor - available + 1
            position = viewer_offset if selected else offset
            position = min(max(0, position), max(0, len(content) - available))
            if selected:
                viewer_offset = position
            else:
                offset = position
            for y, (text, agent) in enumerate(content[position:position+available]):
                attr = curses.A_BOLD if text.isupper() else curses.A_NORMAL
                if curses.has_colors():
                    attr |= curses.color_pair(3)
                if curses.has_colors() and (text.isupper() or agent):
                    attr = (attr & ~curses.A_COLOR) | curses.color_pair(2 if agent else 1)
                if not selected and position + y == cursor:
                    attr |= curses.A_REVERSE
                try:
                    screen.addnstr(y, 1, safe(text), max(0, width-2), attr)
                except curses.error:
                    pass
            footer = 'Disconnected - q close' if closed else ('Esc back / arrows scroll / q close' if selected else 'a agents / arrows scroll / q close')
            try:
                screen.addnstr(height-1, 0, footer, max(0, width-1), curses.A_DIM)
            except curses.error:
                pass
            screen.refresh()
            key = screen.getch()
            if key in (ord('q'), 3):
                break
            if key == 27:
                select(None)
            if key in (curses.KEY_DOWN, ord('j'), curses.KEY_NPAGE):
                step = available if key == curses.KEY_NPAGE else 1
                if selected:
                    viewer_offset += step
                else:
                    cursor += step
            if key in (curses.KEY_UP, ord('k'), curses.KEY_PPAGE):
                step = available if key == curses.KEY_PPAGE else 1
                if selected:
                    viewer_offset -= step
                else:
                    cursor -= step
            if key == ord('a') and not selected:
                cursor = next((i for i, (_, a) in enumerate(content) if a), cursor)
            if key in (10, 13) and not selected:
                if content[cursor][1]:
                    select(content[cursor][1])
            if key == curses.KEY_MOUSE and not selected:
                try:
                    _, _, y, _, buttons = curses.getmouse()
                    index = offset + y
                    if buttons & (curses.BUTTON1_CLICKED | curses.BUTTON1_PRESSED) and 0 <= y < available and index < len(content):
                        if content[index][1]:
                            select(content[index][1])
                except curses.error:
                    pass
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    identity = parser.add_mutually_exclusive_group(required=True)
    identity.add_argument('--thread')
    identity.add_argument('--binding', help='Private identity file produced by the console launcher')
    parser.add_argument('--cwd', default=os.getcwd())
    parser.add_argument('--url', default='ws://127.0.0.1:' + os.environ.get('TG_CODEX_WS_PORT', '3210'))
    parser.add_argument('--window-uid')
    parser.add_argument('--bridge-server', help='Exact configured MCP key for a custom PolyDaemon registration')
    parser.add_argument('--memory-server', help='Exact configured MCP key for a custom memory registration')
    parser.add_argument('--split', action='store_true', help='Open a 44-column pane in the current tmux window')
    args = parser.parse_args()
    if args.split:
        if not os.environ.get('TMUX') or not shutil.which('tmux'):
            parser.error('--split requires an existing tmux session; omit it in a separate terminal')
        identity = ['--thread', args.thread] if args.thread else ['--binding', args.binding]
        command = [sys.executable, str(Path(__file__).resolve()), *identity,
                   '--cwd', str(Path(args.cwd).resolve()), '--url', args.url]
        if args.window_uid:
            command += ['--window-uid', args.window_uid]
        for name in ('bridge_server', 'memory_server'):
            if getattr(args, name):
                command += ['--' + name.replace('_', '-'), getattr(args, name)]
        # tmux uses a shell for its command argument; quote every argv component.
        subprocess.run(['tmux', 'split-window', '-h', '-l', '44', '-d', shlex.join(command)], check=True)
        return
    try:
        import curses
    except ImportError:
        parser.error('This terminal needs Python curses (native on macOS/Linux; Windows is not yet validated)')
    bun = shutil.which('bun')
    if not bun:
        parser.error('bun is required')
    identity = ['--thread', args.thread] if args.thread else ['--binding', args.binding]
    worker = [bun, str(Path(__file__).with_suffix('.ts')), *identity,
              '--cwd', str(Path(args.cwd).resolve()), '--url', args.url]
    if args.window_uid:
        worker += ['--window-uid', args.window_uid]
    for name in ('bridge_server', 'memory_server'):
        if getattr(args, name):
            worker += ['--' + name.replace('_', '-'), getattr(args, name)]
    curses.wrapper(run, worker, args)


if __name__ == '__main__':
    main()
