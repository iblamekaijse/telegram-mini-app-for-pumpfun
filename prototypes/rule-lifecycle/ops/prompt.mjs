import { createInterface } from 'node:readline/promises';
import { LocalError } from './config.mjs';
export async function secretPrompt(label, { input = process.stdin, output = process.stdout } = {}) {
  if(!input.isTTY||typeof input.setRawMode!=='function')throw new LocalError('TOKEN_REQUIRED','Нужен токен: запустите npm run setup в терминале. В переписку и аргументы команд его не передавайте.');
  let value='',raw=input.isRaw;
  return new Promise((resolve,reject)=>{
    function finish(error){input.off('data',data);input.off('error',failed);try{input.setRawMode(!!raw);}catch{error??=new LocalError('INPUT_FAILED','Терминал недоступен. Повторите setup.');}input.pause();try{output.write('\n');}catch{}error?reject(error):resolve(value);}
    function failed(){finish(new LocalError('INPUT_FAILED','Ввод не завершён. Повторите setup в терминале.'));}
    function data(chunk){for(const ch of chunk.toString()){
      if(ch==='\u0003'){finish(new LocalError('CANCELLED','Настройка отменена.'));return;}
      if(ch==='\r'||ch==='\n'){finish();return;}
      if(ch==='\u007f'||ch==='\b')value=value.slice(0,-1);
      else if(ch>=' '&&ch<='~')value+=ch;
    }}
    try{input.setRawMode(true);output.write(label);input.on('data',data);input.on('error',failed);input.resume();}catch{failed();}
  });
}
export async function confirmPrompt(label) {
  if(!process.stdin.isTTY)return '';
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try{return (await rl.question(label)).trim();}finally{rl.close();}
}
