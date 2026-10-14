"""Native Windows cmd/PowerShell launcher checks, without model/daemon calls."""
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

REPO = Path(__file__).resolve().parent.parent


@unittest.skipUnless(os.name == 'nt', 'requires native Windows cmd and PowerShell 7')
class WindowsLaunchers(unittest.TestCase):
    def test_claude_identity_selection_and_compact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            physical = root / 'Physical project'
            physical.mkdir()
            alias = root / 'Logical alias'
            subprocess.run(['cmd.exe','/c','mklink','/J',str(alias),str(physical)], capture_output=True, check=True)
            profile = root / 'profile'
            history = profile / '.claude/projects' / re.sub(r'[^\w]|_', '-', str(physical)) / 'saved.jsonl'
            history.parent.mkdir(parents=True)
            history.write_text('saved')
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            capture = bin_dir / 'capture.py'
            capture.write_text("import json,os,sys;print(json.dumps({'args':sys.argv[1:],'name':os.getenv('TG_WS_NAME'),'instance':os.getenv('TG_BRIDGE_INSTANCE_NAME'),'updater':os.getenv('DISABLE_AUTOUPDATER')}))")
            (bin_dir / 'claude.cmd').write_text(f'@echo off\n"{sys.executable}" "{capture}" %*\n')
            shutil.copyfile(REPO / 'polydaemon-claude.cmd', physical / 'polydaemon-claude.cmd')
            env = {k:v for k,v in os.environ.items() if not re.match(r'^(TG_|CLAUDE|CODEX|MIMOCODE|TMUX)',k,re.I)}
            env.update(USERPROFILE=str(profile), HOME=str(profile), TG_BRIDGE_REPO=str(REPO), PATH=str(bin_dir)+os.pathsep+os.environ['PATH'])
            def run(*args, extra=None):
                cmd = subprocess.list2cmdline([str(alias / 'polydaemon-claude.cmd'), *args])
                return subprocess.run(f'cmd.exe /d /s /c "{cmd}"', env={**env,**(extra or {})},capture_output=True,text=True,timeout=15)
            def call(*args, extra=None):
                result = run(*args, extra=extra)
                self.assertEqual(result.returncode,0,result.stderr)
                return json.loads(result.stdout)
            default = call()
            self.assertIn('--continue', default['args'])
            self.assertEqual(default['name'], 'Logical_alias')
            self.assertEqual(default['instance'], default['name'])
            self.assertEqual(default['updater'], '1')
            self.assertIn('--settings',default['args'])
            overlay = profile / '.tg-bridge-channel/launch-no-autocompact.json'
            self.assertEqual(json.loads(overlay.read_text()),{'autoCompactEnabled':False})
            for args in (('--resume','saved'), ('-r','saved'), ('new',)):
                self.assertNotIn('--continue',call(*args)['args'])
            self.assertNotIn('--continue',call(extra={'TG_CLAUDE_NEW':'1'})['args'])
            for args in (('--resume','saved'), ('-c',), ('--fork-session',)):
                self.assertNotEqual(run(*args,extra={'TG_CLAUDE_NEW':'1'}).returncode,0)
            kept = call(extra={'TG_KEEP_AUTOCOMPACT':'1','TG_WS_NAME':'custom-name'})
            self.assertNotIn('--settings',kept['args'])
            self.assertEqual(kept['instance'],'custom-name')
            explicit = call('--settings','caller.json')
            self.assertEqual(explicit['args'].count('--settings'),1)
            self.assertEqual(explicit['args'][-2:],['--settings','caller.json'])
            overlay.unlink()
            self.assertEqual(call('--help')['args'], ['--help'])
            self.assertEqual(call('--version')['args'], ['--version'])
            self.assertFalse(overlay.exists())
            self.assertEqual(history.read_text(),'saved')

    def test_native_codex_session_contract(self):
        """Real cmd dispatcher, loopback daemon fixture and captured CLI argv."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / 'physical project'
            workspace.mkdir()
            alias = root / 'alias project'
            subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(alias), str(workspace)],
                           capture_output=True, check=True)
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            capture = bin_dir / 'capture.py'
            capture.write_text("import json,os,sys; print(json.dumps({'args':sys.argv[1:],'cwd':os.getcwd()}))")
            for cli in ('codex', 'bun'):
                (bin_dir / f'{cli}.cmd').write_text(f'@echo off\n"{sys.executable}" "{capture}" %*\n')
            native = bin_dir / 'node_modules/@openai/codex/vendor/codex.exe'
            native.parent.mkdir(parents=True)
            native.write_bytes(b'fixture, never executed')
            profile = root / 'profile'
            state = profile / '.tg-bridge'
            state.mkdir(parents=True)
            responses = {'body': {'thread_id': 'thread-123'}, 'status': 200}
            requests = []
            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    requests.append((self.path, self.headers.get('Authorization')))
                    if 'last-thread?' in self.path:
                        body = responses['body']
                        self.send_response(responses['status'])
                    else:
                        body = {'ok': True, 'app_server': 'up'}
                        self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write((body if isinstance(body, str) else json.dumps(body)).encode())
                def log_message(self, *args):
                    pass
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            config = state / 'agent.toml'
            config.write_text(f'auth_token = "fixture"\nport = {server.server_port}\n')
            env = {k: v for k, v in os.environ.items()
                   if not re.match(r'^(TG_|CLAUDE|CODEX|MIMOCODE|TMUX)', k, re.I)}
            env.update(PATH=str(bin_dir)+os.pathsep+os.environ['PATH'], HOME=str(profile),
                       USERPROFILE=str(profile), TG_BRIDGE_REPO=str(REPO), TG_CODEX_WS_PORT='43210')
            launcher = workspace / 'polydaemon-codex.cmd'
            shutil.copyfile(REPO / launcher.name, launcher)
            def run(*args, extra=None):
                requests.clear()
                command = subprocess.list2cmdline([str(alias / launcher.name), *args])
                return subprocess.run(f'cmd.exe /d /s /c "{command}"', env={**env, **(extra or {})},
                                      capture_output=True, text=True, timeout=20)
            def passed(*args, extra=None):
                result = run(*args, extra=extra)
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout)['args']
            try:
                argv = passed()
                self.assertEqual(argv, ['--remote','ws://127.0.0.1:43210','resume','thread-123','--cd',str(workspace)])
                lookup = [r for r in requests if 'last-thread?' in r[0]]
                self.assertEqual(len(lookup), 1)
                self.assertEqual(parse_qs(urlparse(lookup[0][0]).query)['cwd'], [str(workspace)])
                self.assertEqual(lookup[0][1], 'Bearer fixture')
                for value in (None, ''):
                    responses['body'] = {'thread_id': value}
                    self.assertNotIn('resume', passed())
                for body in ({}, {'ok': False, 'thread_id': None}, {'thread_id': 0},
                             {'thread_id': False}, {'thread_id': 'bad/id'}, {'thread_id': 'id\n'}, 'not json'):
                    responses['body'] = body
                    result = run()
                    self.assertNotEqual(result.returncode, 0, body)
                    self.assertEqual(result.stdout.strip(), '', body)
                responses.update(body={'thread_id': None}, status=503)
                result = run()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Codex last-thread lookup failed', result.stderr)
                responses['status'] = 200
                for selector in ('resume', 'fork'):
                    argv = passed(selector, 'explicit-123')
                    self.assertEqual(argv[-2:], [selector, 'explicit-123'])
                    self.assertFalse(any('last-thread?' in r[0] for r in requests))
                flags = ['-c','key=value','-p','-Plan','-a','on-request','-s','workspace-write']
                argv = passed('new', *flags, extra={'TG_CODEX_CHECK_UPDATE': '0'})
                self.assertEqual(argv[-len(flags):], flags)
                self.assertIn('check_for_update_on_startup=false', argv)
                self.assertFalse(any('last-thread?' in r[0] for r in requests))
                self.assertNotIn('resume', passed(extra={'TG_CODEX_NEW':'1'}))
                for args in (('new','resume'), ('new','fork'), ('resume', 'x')):
                    result = run(*args, extra={'TG_CODEX_NEW':'1'})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('new cannot be combined', result.stderr)
                    self.assertEqual(requests, [])
                config.unlink()
                native.unlink()
                for command in (('--help',), ('--version',), ('mcp','list'), ('exec','fixture'), ('-c','key=value','mcp','list')):
                    argv = passed(*command, extra={'TG_CODEX_CHECK_UPDATE':'0'})
                    self.assertEqual(argv, ['--cd', str(workspace), *command])
                    self.assertEqual(requests, [])
                host = root / 'ps5-host.ps1'
                host.write_text(f"& '{alias / launcher.name}' --version\nexit $LASTEXITCODE\n",encoding='utf-8-sig')
                result = subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(host)],
                                        env=env,capture_output=True,text=True,timeout=20)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(json.loads(result.stdout)['args'],['--cd',str(workspace),'--version'])
                self.assertEqual(requests, [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_new_default_conflicts_and_workspace_quoting(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / 'Project # test & space'
            workspace.mkdir()
            profile = root / 'profile'
            encoded = re.sub(r'[^\w]|_', '-', str(workspace))
            history = profile / '.claude' / 'projects' / encoded / 'session.jsonl'
            history.parent.mkdir(parents=True)
            history.write_text('preserved history')
            env = {**os.environ, 'USERPROFILE': str(profile), 'TG_BRIDGE_REPO': str(REPO)}
            env.pop('TG_MIMO_NEW', None)
            env.pop('TG_OPENCODE_NEW', None)
            for agent in ('claude', 'codex', 'opencode', 'mimo'):
                launcher = workspace / f'polydaemon-{agent}.cmd'
                shutil.copyfile(REPO / launcher.name, launcher)
                def run(*args):
                    command = subprocess.list2cmdline([str(launcher), *args])
                    return subprocess.run(f'cmd.exe /d /s /c "{command}"',
                                          env=env, capture_output=True, text=True)
                with self.subTest(agent=agent):
                    fresh = run('new', '-Plan')
                    self.assertEqual(fresh.returncode, 0, fresh.stderr)
                    plan = json.loads(fresh.stdout)
                    self.assertTrue(plan['fresh'])
                    self.assertEqual(plan['workspace'], str(workspace))
                    self.assertNotIn('--continue', plan['arguments'])
                    self.assertNotIn(None, plan['arguments'])
                    if agent != 'codex':
                        self.assertNotIn('new', plan['arguments'])
                    if agent in ('mimo', 'opencode'):
                        self.assertEqual(plan[agent + 'New'], '1')
                    if agent != 'mimo':
                        forwarded = run('new', '-Plan', '--model', 'test-model')
                        self.assertEqual(forwarded.returncode, 0, forwarded.stderr)
                        self.assertEqual(json.loads(forwarded.stdout)['arguments'][-2:], ['--model', 'test-model'])
                    default = run('-Plan')
                    self.assertEqual(default.returncode, 0, default.stderr)
                    plan = json.loads(default.stdout)
                    self.assertFalse(plan['fresh'])
                    if agent == 'claude':
                        self.assertIn('--continue', plan['arguments'])
                    for conflict in ('resume', '--session=ses_123', '--continue', '-r', 'fork', '--fork-session'):
                        self.assertNotEqual(run('new', '-Plan', conflict).returncode, 0)
            self.assertEqual(history.read_text(), 'preserved history')

    def test_direct_codex_conflict_before_daemon_or_cli(self):
        result = subprocess.run(['pwsh.exe', '-NoProfile', '-File',
                                 str(REPO / 'clients/polydaemon-codex.ps1'),
                                 '-Workspace', str(REPO), 'new', 'resume'],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('new cannot be combined', result.stderr)

    def test_direct_codex_consumes_new(self):
        result = subprocess.run(['pwsh.exe', '-NoProfile', '-File',
                                 str(REPO / 'clients/polydaemon-codex.ps1'),
                                 '-Workspace', str(REPO), '-Plan', 'new', '--model', 'test-model'],
                                capture_output=True, text=True, check=True)
        plan = json.loads(result.stdout)
        self.assertTrue(plan['fresh'])
        self.assertNotIn('new', plan['arguments'])
        self.assertEqual(plan['arguments'][-2:], ['--model', 'test-model'])

    def test_agent_aware_guards_and_physical_parent_alias(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            physical = root / 'Physical'
            child = physical / 'Child'
            child.mkdir(parents=True)
            alias = root / 'Alias'
            subprocess.run(['cmd.exe','/c','mklink','/J',str(alias),str(physical)],capture_output=True,check=True)
            harness = root / 'guard.ps1'
            path = str(alias / 'Child').lower().replace('\\','/')
            harness.write_text(
                f". '{REPO / 'clients/polydaemon-session-args.ps1'}'\n"
                f"if ((Resolve-PolyDaemonWorkspace '{path}') -cne '{child}') {{ throw 'Physical/casing mismatch' }}\n"
                "$ErrorActionPreference='Stop'\n"
                "foreach ($agent in @('claude','mimo','opencode','codex')) {\n"
                " [Environment]::SetEnvironmentVariable(('TG_'+$agent.ToUpperInvariant()+'_NEW'),'1')\n"
                " $fresh=Get-PolyDaemonSessionArgs -Agent $agent -Arguments @('--model','resume')\n"
                " if (!$fresh.New -or $fresh.ExplicitSelection) { throw 'Value mistaken for selection' }\n"
                " $flag=if ($agent -eq 'claude') {'-c'} elseif ($agent -eq 'codex') {'--fork-session'} else {'-s'}\n"
                " $rejected=$false; try { Get-PolyDaemonSessionArgs -Agent $agent -Arguments @($flag) | Out-Null } catch { $rejected=$true }\n"
                " if (!$rejected) { throw ('Missing conflict guard: '+$agent) }\n"
                " [Environment]::SetEnvironmentVariable(('TG_'+$agent.ToUpperInvariant()+'_NEW'),$null)\n"
                "}\nWrite-Output 'guards/physical alias PASS'\n",encoding='utf-8-sig')
            result = subprocess.run(['pwsh.exe','-NoProfile','-File',str(harness)],capture_output=True,text=True,timeout=15)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn('guards/physical alias PASS',result.stdout)

    def test_actual_command_dispatch_with_stubs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / 'Actual Project & spaces'
            workspace.mkdir()
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            capture = bin_dir / 'capture.py'
            capture.write_text("import json,os,sys; print(json.dumps({'args':sys.argv[1:],'cwd':os.getcwd(),'mimo':os.environ.get('TG_MIMO_NEW'),'opencode':os.environ.get('TG_OPENCODE_NEW')}))")
            for cli in ('claude', 'bun', 'codex'):
                (bin_dir / f'{cli}.cmd').write_text(f'@echo off\n"{sys.executable}" "{capture}" %*\n')
            native = bin_dir / 'node_modules/@openai/codex/vendor/codex.exe'
            native.parent.mkdir(parents=True)
            native.write_bytes(b'test only')
            profile = root / 'profile'
            state = profile / '.tg-bridge'
            state.mkdir(parents=True)
            (state / 'agent.toml').write_text('auth_token = "test-token"\n')
            env = {**os.environ,'PATH':str(bin_dir)+os.pathsep+os.environ['PATH'],
                   'USERPROFILE':str(profile),'TG_BRIDGE_REPO':str(REPO)}
            for agent in ('claude','opencode','mimo'):
                launcher = workspace / f'polydaemon-{agent}.cmd'
                shutil.copyfile(REPO / launcher.name, launcher)
                command = subprocess.list2cmdline([str(launcher),'new'])
                result = subprocess.run(f'cmd.exe /d /s /c "{command}"',env=env,capture_output=True,text=True,check=True)
                call = json.loads(result.stdout)
                self.assertEqual(call['cwd'],str(workspace))
                self.assertNotIn('new',call['args'])
                self.assertNotIn('--continue',call['args'])
                if agent in ('opencode','mimo'):
                    self.assertEqual(call[agent],'1')
                    self.assertTrue(call['args'][1].endswith(f'{agent}-launch.ts'))
            harness = root / 'codex-harness.ps1'
            for selector in ('', 'new '):
                harness.write_text("function Invoke-RestMethod { param($Uri,$Headers,$TimeoutSec); if ($Uri -like '*/health') { return @{ok=$true} }; if ($Uri -like '*/last-thread?*') { return @{ok=$true;thread_id=$null} }; return @{app_server='up'} }\n"
                                   + f"& '{REPO / 'clients/polydaemon-windows.ps1'}' -Agent codex -Workspace '{workspace}' {selector}--model test-model\n")
                result = subprocess.run(['pwsh.exe','-NoProfile','-File',str(harness)],env=env,capture_output=True,text=True,check=True)
                call = json.loads(result.stdout)
                self.assertEqual(call['cwd'],str(workspace))
                self.assertEqual(call['args'],['--remote','ws://127.0.0.1:3210','--cd',str(workspace),'--model','test-model'])
            launcher = workspace / 'polydaemon-codex.cmd'
            shutil.copyfile(REPO / launcher.name, launcher)
            command = subprocess.list2cmdline([str(launcher), '--version'])
            result = subprocess.run(f'cmd.exe /d /s /c "{command}"',env=env,capture_output=True,text=True,check=True)
            call = json.loads(result.stdout)
            self.assertEqual(call['args'][0],'--cd')
            self.assertEqual(Path(call['args'][1]),workspace)
            self.assertEqual(call['args'][2:],['--version'])


if __name__ == '__main__':
    unittest.main()
