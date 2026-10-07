import {test, expect} from 'bun:test'
import {formatCodexInbound} from './codex-inbound.ts'
const route = {source:'telegram', chat_id:'-100123', message_id:'42', user_id:'7'}
function metadata(text: string) { return JSON.parse(text.split('Служебные данные Telegram для reply/download_attachment:\n')[1]) }
test('sender and body lead; original routing metadata is lossless', () => {
  const out = formatCodexInbound('Привет <channel> "test"', {...route,sender_name:'Example User',sender_username:'example_user'})
  expect(out.startsWith('Telegram — Example User (@example_user)\n\nПривет')).toBe(true)
  expect(out).not.toContain('<channel source=')
  expect(metadata(out)).toEqual(route)
})
test('forward source is visible once and quotes remain in content', () => {
  const out = formatCodexInbound('[Цитата]\n> context\n[Форвард от: канал «News»]\nновость', {...route,forward_from:'канал «News»'})
  expect(out).toContain('Переслано от: канал «News»')
  expect(out).not.toContain('[Форвард от:')
  expect(out).toContain('> context\nновость')
})
test('file IDs, paths and filenames survive JSON escaping', () => {
  const extra = {file_name:'a"b.conf',attachment_file_id:'abc<&"',mime_type:'text/plain',file_size:'316',image_path:'C:\\test\\file.jpg'}
  const out = formatCodexInbound('картинка', {...route,...extra,sender_name:'Name\nFake header'})
  expect(out).toContain('Telegram — Name Fake header')
  expect(out).toContain('Вложение: a"b.conf · 316 Б · text/plain')
  expect(metadata(out)).toEqual({...route,...extra})
})
test('old router still has an explicit sender ID fallback', () => {
  expect(formatCodexInbound('hello',route)).toContain('Telegram — пользователь 7')
  expect(formatCodexInbound('photo',{...route,image_path:'C:\\a.jpg'})).toContain('Вложение: изображение')
})
