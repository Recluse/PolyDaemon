"""Optional native tmux check: PD_NATIVE_TMUX=1 python3 clients/test_codex_console.py."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('console', REPO / 'clients/codex-console.py')
console = importlib.util.module_from_spec(spec)
spec.loader.exec_module(console)


class Console(unittest.TestCase):
    def test_private_environment_handoff_preserves_new_tmux_identity(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            path = Path(tmp) / 'launch.json'
            path.write_text(json.dumps({'cwd': os.getcwd(), 'env': {'VALUE': 'this-launch', 'TMUX_PANE': '%old'}}))
            os.environ.update(TMUX='new-server', TMUX_PANE='%new', TERM='screen')
            console.read_spec(path)
            self.assertEqual(os.environ['VALUE'], 'this-launch')
            self.assertEqual(os.environ['TMUX_PANE'], '%new')
            self.assertEqual(os.environ['TMUX'], 'new-server')
            self.assertFalse(path.exists())

    @unittest.skipUnless(os.name == 'posix' and os.environ.get('PD_NATIVE_TMUX') == '1', 'optional native tmux check')
    def test_console_default_new_and_resume(self):
        import fcntl
        import pty
        import select
        import struct
        import termios
        tmux = shutil.which('tmux')
        bun = shutil.which('bun')
        self.assertTrue(tmux and bun)
        (REPO / 'tmp').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=REPO / 'tmp', prefix='codex-console-test-') as tmp:
            root = Path(tmp)
            workspace = root / 'Project with space & quote'
            workspace.mkdir()
            shutil.copyfile(REPO / 'polydaemon-codex.sh', workspace / 'polydaemon-codex.sh')
            home, bin_dir = root / 'home', root / 'bin'
            home.mkdir(); bin_dir.mkdir()
            socket = str(root / 'tmux.sock')
            env = {'PATH': str(bin_dir) + os.pathsep + os.environ['PATH'], 'HOME': str(home),
                   'USERPROFILE': str(home), 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8',
                   'TG_BRIDGE_REPO': str(REPO), 'TG_CODEX_SIDEBAR': '1'}
            wrapper = bin_dir / 'tmux'
            wrapper.write_text('#!/bin/sh\nexec ' + shlex.join([tmux, '-S', socket, '-f', '/dev/null']) + ' "$@"\n')
            wrapper.chmod(0o700)
            fixture = root / 'fixture.ts'
            fixture.write_text('''
const root = process.argv[2]
const seen = new Map()
const server = Bun.serve({hostname:'127.0.0.1',port:0,
  fetch(req,s) {if(s.upgrade(req))return; return new Response('ok')},
  websocket:{message(ws,raw){
    const m=JSON.parse(String(raw)); if(!m.id)return
    let result:any={}
    if(['thread/start','thread/resume'].includes(m.method)){
      const id=m.params?.threadId||m.params?.fixtureName||'fresh-thread'
      const thread={id,cwd:root,model:'fixture-model',status:{type:'idle'}}
      seen.set(id,thread);result={thread}
    } else if(m.method==='thread/read') result={thread:seen.get(m.params.threadId)}
    else if(m.method==='thread/list'||m.method==='mcpServerStatus/list')result={data:[]}
    ws.send(JSON.stringify({id:m.id,result}))
    if(['thread/start','thread/resume'].includes(m.method)) {
      ws.send(JSON.stringify({method:'thread/tokenUsage/updated',params:{threadId:result.thread.id,
        tokenUsage:{last:{totalTokens:12000},total:{totalTokens:900000},modelContextWindow:128000}}}))
      ws.send(JSON.stringify({method:'thread/tokenUsage/updated',params:{threadId:'foreign',
        tokenUsage:{last:{totalTokens:99999},modelContextWindow:128000}}}))
    }
  }}})
console.log(server.port)
''')
            codex = bin_dir / 'codex'
            codex.write_text(f'#!{bun}\n' + '''
const args=process.argv.slice(2), url=args[args.indexOf('--remote')+1]
const ws=new WebSocket(url)
ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'initialize',params:{}}))
ws.onmessage=e=>{
  const m=JSON.parse(String(e.data))
  if(m.id===1){const index=args.indexOf('resume');ws.send(JSON.stringify({id:2,
    method:index<0?'thread/start':'thread/resume',params:index<0?{}:{threadId:args[index+1]}}))}
  if(m.id===2||m.id===3)console.log('CODEX-FIXTURE '+m.result.thread.id)
}
for await(const raw of console){
  if(raw.trim()==='q'){ws.close();process.exit(0)}
  if(raw.trim()==='n')ws.send(JSON.stringify({id:3,method:'thread/start',params:{fixtureName:'next-thread'}}))
}
''')
            codex.chmod(0o700)
            server = subprocess.Popen([bun, str(fixture), str(workspace)], stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True, env=env)
            port = server.stdout.readline().strip()
            env['TG_CODEX_WS_PORT'] = port
            def tmux_call(*args):
                return subprocess.run([tmux, '-S', socket, *args], capture_output=True, text=True)
            try:
                for args, thread, existing in (([], 'fresh-thread', False), (['new'], 'fresh-thread', False),
                                                (['resume', 'saved-thread'], 'saved-thread', False),
                                                (['new'], 'fresh-thread', True)):
                    master, slave = pty.openpty()
                    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 140, 0, 0))
                    launch = ['bash', str(workspace / 'polydaemon-codex.sh'), *args]
                    if existing:
                        launch = [str(wrapper), 'new-session', '-s', 'existing', '-c', str(workspace), shlex.join(launch)]
                    proc = subprocess.Popen(launch,
                                            env=env, stdin=slave, stdout=slave, stderr=slave)
                    os.close(slave)
                    try:
                        panels = {}
                        deadline = time.monotonic() + 15
                        while time.monotonic() < deadline:
                            if select.select([master], [], [], .1)[0]:
                                os.read(master, 65536)
                            panes = tmux_call('list-panes', '-a', '-F', '#{pane_id}').stdout.splitlines()
                            panels = {p: tmux_call('capture-pane', '-p', '-t', p).stdout for p in panes}
                            if len(panels) == 2 and any('CODEX-FIXTURE '+thread in text for text in panels.values()) and any('Thread: '+thread in text and 'Context: 12,000' in text for text in panels.values()):
                                break
                        self.assertEqual(len(panels), 2, panels)
                        self.assertTrue(any('Thread: '+thread in text for text in panels.values()), panels)
                        self.assertTrue(any('Context: 12,000 / 128,000 (9%)' in text for text in panels.values()), panels)
                        left = next(p for p, text in panels.items() if 'CODEX-FIXTURE' in text)
                        if existing:
                            right = next(p for p in panels if p != left)
                            tmux_call('send-keys', '-t', left, 'n', 'Enter')
                            deadline = time.monotonic() + 8
                            while time.monotonic() < deadline:
                                if select.select([master], [], [], .1)[0]: os.read(master, 65536)
                                text = tmux_call('capture-pane', '-p', '-t', right).stdout
                                if 'Thread: next-thread' in text: break
                            self.assertIn('Thread: next-thread', text)
                            self.assertNotIn('Thread: fresh-thread', text)
                        tmux_call('send-keys', '-t', left, 'q', 'Enter')
                        deadline = time.monotonic() + 8
                        while proc.poll() is None and time.monotonic() < deadline:
                            if select.select([master], [], [], .1)[0]:
                                try: os.read(master, 65536)
                                except OSError: break
                        proc.wait(timeout=3)
                        self.assertEqual(proc.returncode, 0)
                        self.assertFalse(list((workspace / 'tmp').glob('.polydaemon-codex-*')))
                    finally:
                        tmux_call('kill-server')
                        if proc.poll() is None: proc.kill(); proc.wait()
                        os.close(master)
            finally:
                tmux_call('kill-server')
                server.terminate(); server.wait(timeout=5)
                server.stdout.close(); server.stderr.close()


if __name__ == '__main__':
    unittest.main()
