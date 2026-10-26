import { readFileSync, existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, chmodSync, unlinkSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as util from 'node:util';
export const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
export class LocalError extends Error { constructor(code, message) { super(message); this.code = code; } }
export function compatible(version = process.versions.node) {
  const [major,minor] = version.split('.').map(Number); return major > 24 || major === 24 && minor >= 19;
}
export function settings({ cwd = process.cwd(), env = process.env, root = APP_ROOT } = {}) {
  let configPath = resolve(cwd, env.DEMO_ENV_FILE || '.env'), text = '', file = {};
  try {
    text=readFileSync(configPath,'utf8');configPath=realpathSync(configPath);file=util.parseEnv(text);
  } catch(error) {
    if(error.code!=='ENOENT')throw new LocalError('CONFIG_INVALID','Конфигурация недоступна или некорректна. Проверьте права и синтаксис .env.');
  }
  const values = { ...file, ...env };
  const dataDir = resolve(cwd, values.DEMO_DATA_DIR || resolve(root,'.local-web'));
  const port = Number(values.DEMO_PORT ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new LocalError('CONFIG_INVALID','DEMO_PORT должен быть целым числом 0…65535.');
  return { configPath, dataDir, dbPath: resolve(dataDir,'state.sqlite'), port, token: values.TELEGRAM_BOT_TOKEN || '',
    botId: values.TELEGRAM_BOT_ID || '', text, file };
}
export function editConfig(text, changes) {
  let lines = text.split(/\r?\n/);
  // parseEnv accepts multiline quoted values; replace fields by scanning complete entries, preserving other content.
  for (const [key,value] of Object.entries(changes)) {
    let quoted = null;
    const kept = [];
    for (let i=0;i<lines.length;i++) {
      const line=lines[i], match=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || match[1] !== key) { kept.push(line); continue; }
      const start=match[2][0];
      if ((start==='"'||start==="'") && !match[2].slice(1).includes(start)) {
        quoted=start; while(i+1<lines.length){i++;if(lines[i].includes(quoted))break;}
      }
    }
    if (/[\r\n\0]/.test(String(value))) throw new LocalError('CONFIG_INVALID','Настройка содержит недопустимый перевод строки.');
    const candidates = [JSON.stringify(String(value)), `"${String(value)}"`, `'${String(value)}'`];
    const encoded=candidates.find(candidate=>util.parseEnv(`VALUE=${candidate}`).VALUE===String(value));
    if(!encoded)throw new LocalError('CONFIG_INVALID','Значение содержит неподдерживаемые кавычки. Выберите простой абсолютный путь.');
    lines=[...kept,`${key}=${encoded}`];
  }
  return lines.join('\n').replace(/^\n+/, '')+'\n';
}
export function atomicFile(path, text) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const temporary=`${path}.tmp-${process.pid}-${Date.now()}`;
  let fd;
  try {
    fd=openSync(temporary,'wx',0o600);writeFileSync(fd,text);fsyncSync(fd);closeSync(fd);fd=undefined;
    renameSync(temporary,path);chmodSync(path,0o600);
    const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
  } finally {if(fd!==undefined)closeSync(fd);if(existsSync(temporary))unlinkSync(temporary);}
}
