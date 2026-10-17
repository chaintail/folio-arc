import {openSync,closeSync,fstatSync,readFileSync,realpathSync,constants} from 'node:fs';
import {resolve} from 'node:path';
export function allowedPath(path:string) {
 const absolute=resolve(path);
 if(absolute.split('/').some(p=>p==='.secrets'||p==='.env'||p.startsWith('.env.')))throw Error('FORBIDDEN_INPUT_PATH');
 return absolute;
}
/** Reject symlinks and unsafe mode before reading; keys and signed wire never become evidence. */
export function privateFile(path:string) {
 const absolute=allowedPath(path);allowedPath(realpathSync(absolute));
 const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {const s=fstatSync(fd);if(!s.isFile()||(s.mode&0o777)!==0o600||s.uid!==process.getuid?.())throw Error('PRIVATE_FILE_MODE_REQUIRED');return readFileSync(fd,'utf8');}
 finally{closeSync(fd);}
}
