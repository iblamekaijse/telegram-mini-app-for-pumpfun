import { existsSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LocalError } from './config.mjs';
import { validateSnapshot } from '../state-schema.mjs';
export const checksum = value => createHash('sha256').update(value).digest('hex');
export const fileChecksum = path => checksum(readFileSync(path));
export function validatedPayload(row) {
  try {
    if (!row || checksum(row.payload)!==row.sha256) throw new Error();
    const raw=JSON.parse(row.payload), state=validateSnapshot(structuredClone(raw));
    return {raw,state};
  } catch {throw new LocalError('STORAGE_INVALID','База повреждена или версия данных не поддерживается. Сохраните файл и используйте совместимую копию; не удаляйте историю.');}
}
export async function inspectDatabase(path, { exclusive = false } = {}) {
  if(!existsSync(path)||!statSync(path).isFile())throw new LocalError('STORAGE_MISSING','Файл истории отсутствует. Не создавайте пустую базу вместо существовавшей.');
  const { DatabaseSync }=await import('node:sqlite');let db;
  try {
    db=new DatabaseSync(path,{readOnly:!exclusive});
    db.exec('PRAGMA busy_timeout=0;');
    if(exclusive){db.exec('PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;');
      if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='delete')throw new LocalError('STORAGE_MODE','Нужна поддерживаемая база приложения с журналом DELETE. Копия не выполняется для другого режима; используйте согласованную SQLite-копию.');
    }
    const check=db.prepare('PRAGMA integrity_check').all();
    if(check.length!==1||check[0].integrity_check!=='ok')throw new LocalError('STORAGE_INVALID','Проверка целостности SQLite не пройдена. Сохраните файл; используйте исправную копию.');
    const rows=db.prepare('SELECT payload,sha256 FROM snapshot').all();
    if(rows.length!==1)throw new LocalError('STORAGE_INVALID','В базе отсутствует единственная сохранённая история.');
    const data=validatedPayload(rows[0]);
    return { ...data, close(){if(exclusive)db.exec('ROLLBACK;');db.close();}, db };
  } catch(error){try{db?.close();}catch{}if(error instanceof LocalError)throw error;
    throw new LocalError([5,6].includes(error.errcode)?'STORAGE_BUSY':'STORAGE_INVALID', [5,6].includes(error.errcode)
      ?'База занята. Остановите приложение Ctrl+C и повторите команду с тем же путём конфигурации.'
      :'База не читается. Проверьте права, версию приложения и резервную копию; файл не сбрасывается.');}
}
