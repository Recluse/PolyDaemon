#!/usr/bin/env python3
"""Own one Codex CLI and its sidebar in the caller's terminal."""
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import subprocess
import sys
import tempfile


def read_spec(path):
    with open(path, encoding='utf-8') as f:
        spec = json.load(f)
    os.unlink(path)
    # A pane must inherit this launch, not an older tmux server's environment.
    terminal = {k: os.environ[k] for k in ('TMUX', 'TMUX_PANE', 'TERM') if k in os.environ}
    os.environ.clear()
    os.environ.update(spec['env'])
    os.environ.update(terminal)
    os.chdir(spec['cwd'])
    return spec


def inside(spec):
    folder = Path(spec['folder'])
    binding = folder / 'binding.json'
    proxy, sidebar = None, None
    scripts = Path(__file__).resolve().parent
    command = spec['command']
    try:
        proxy = subprocess.Popen([shutil.which('bun'), str(scripts / 'codex-launch-proxy.ts'),
                                  command[2], spec['cwd'], str(binding)],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        if not select.select([proxy.stdout], [], [], 10)[0]:
            raise RuntimeError('Sidebar proxy did not start')
        port = json.loads(proxy.stdout.readline())['port']
        panel = [sys.executable, str(scripts / 'codex-sidebar.py'), '--binding', str(binding),
                 '--cwd', spec['cwd'], '--url', command[2]]
        result = subprocess.run(['tmux', 'split-window', '-h', '-l', '44', '-d', '-P', '-F', '#{pane_id}',
                                 '-t', os.environ['TMUX_PANE'], '-c', spec['cwd'], shlex.join(panel)],
                                capture_output=True, text=True, check=True)
        sidebar = result.stdout.strip()
        if not sidebar.startswith('%') or not sidebar[1:].isdigit():
            raise RuntimeError('Invalid sidebar pane ID')
        child_command = [command[0], '--remote', f'ws://127.0.0.1:{port}', *command[3:]]
        return subprocess.run(child_command).returncode
    finally:
        if sidebar:
            subprocess.run(['tmux', 'kill-pane', '-t', sidebar], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if proxy:
            proxy.terminate()
            try:
                proxy.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proxy.kill()
                proxy.wait()
            proxy.stdout.close()
        shutil.rmtree(folder)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--inside':
        return inside(read_spec(sys.argv[2]))
    command = sys.argv[1:]
    if len(command) < 3 or command[1] != '--remote':
        raise ValueError('Expected codex --remote URL ...')
    cwd = str(Path.cwd().resolve())
    scratch = Path(cwd) / 'tmp'
    scratch.mkdir(exist_ok=True)
    if scratch.is_symlink():
        raise ValueError('Workspace tmp must not be a symlink')
    folder = Path(tempfile.mkdtemp(prefix='.polydaemon-codex-', dir=scratch))
    spec = {'folder': str(folder), 'cwd': cwd, 'command': command, 'env': dict(os.environ)}
    if os.environ.get('TMUX') and os.environ.get('TMUX_PANE'):
        return inside(spec)
    path = folder / 'launch.json'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(spec, f)
    inner = [sys.executable, str(Path(__file__).resolve()), '--inside', str(path)]
    try:
        # Foreground attach uses this console; no GUI terminal or detached agent launch.
        result = subprocess.run(['tmux', 'new-session', '-s', 'pd-codex-' + folder.name.rsplit('-', 1)[-1],
                                 '-c', cwd, shlex.join(inner)])
        return result.returncode
    finally:
        # Once consumed, the inner launcher owns cleanup, including after tmux detach.
        if path.exists():
            shutil.rmtree(folder)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('polydaemon-codex: console/sidebar startup failed; use TG_CODEX_SIDEBAR=0 for the plain CLI', file=sys.stderr)
        sys.exit(1)
