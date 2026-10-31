import {spawn} from 'node:child_process';
import {config} from '../dist/config.js';
import {buildApp} from '../dist/app.js';
try {
 const c={...config(),HOST:'127.0.0.1'};
 const {app}=await buildApp(c);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void app.close();});
 await app.listen({host:c.HOST,port:c.PORT});
 const url=`http://127.0.0.1:${c.PORT}`;
 console.log(`Stemme er klar. Åbn ${url} i din browser.`);
 const opener=spawn('open',[url],{stdio:'ignore'});
 opener.on('error',()=>console.log('Browseren kunne ikke åbnes automatisk. Brug adressen ovenfor.'));
} catch {
 console.error('Opstart mislykkedes. Kontrollér Node-version, .env-indstillinger og om Stemme allerede kører.');
 process.exitCode=1;
}
