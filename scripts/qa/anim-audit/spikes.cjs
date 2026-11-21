// Кадры вокруг рывков (ω > 15 рад/с) в сценариях прогона стенда:
//   node scripts/qa/anim-audit/spikes.cjs <tag> cat/id [cat/id ...]            — по 4 рывка с соседними кадрами
//   node scripts/qa/anim-audit/spikes.cjs <tag> cat/id --all [--from t0 --to t1] — все кадры подряд (с frame.tr от --trace)
const path=require('path');
const base=process.env.ANIM_AUDIT_DIR||path.resolve(__dirname,'../../../bench-out/anim-audit');
const argv=process.argv.slice(2);
const opt=(n,d)=>argv.includes(n)?argv[argv.indexOf(n)+1]:d;
const all=argv.includes('--all'), from=Number(opt('--from',0)), to=Number(opt('--to',1e9));
const [tag,...rest]=argv.filter((x,i)=>!x.startsWith('--')&&!['--from','--to'].includes(argv[i-1]));
const want=rest;
const j=require(path.join(base,'raw',tag+'.json'));
const line=(f)=>console.log(f.t,f.clip,'act',f.act,'w',f.w,f.wb,'pen',f.penMM,f.penPair,'jit',f.jit,f.jitB,'prop',f.propVis,'sw',f.sw,'walk',f.walk,'lift',f.lift,f.tr!==undefined?'tr '+JSON.stringify(f.tr):'');
for(const c of j.cats)for(const r of c.results){
 const key=c.cat+'/'+r.id; if(!want.includes(key))continue;
 const fr=r.frames.filter(f=>!f.mark);
 if(all){console.log('==',key);for(const f of fr)if(f.t>=from&&f.t<=to)line(f);continue;}
 const sp=fr.filter(f=>f.w>15);
 console.log('==',key,'spikes',sp.length);
 const shown=new Set();
 for(const s of sp.slice(0,4)){const i=fr.indexOf(s);for(let k=Math.max(0,i-2);k<=Math.min(fr.length-1,i+1);k++){if(shown.has(k))continue;shown.add(k);line(fr[k])}}
 console.log(' marks',r.frames.filter(f=>f.mark).map(f=>f.t+':'+f.mark).join(' | '));
 console.log(' plays',r.plays.map(p=>p.t+':'+p.name+' <'+p.stack.slice(0,70)).join('\n   '));
}
