// Кадры вокруг рывков (ω > 15 рад/с) в сценариях: node scripts/qa/anim-audit/spikes.cjs <tag> cat/id [cat/id ...]
const path=require('path');
const base=process.env.ANIM_AUDIT_DIR||path.resolve(__dirname,'../../../bench-out/anim-audit');
const [tag,...want]=process.argv.slice(2);
const j=require(path.join(base,'raw',tag+'.json'));
for(const c of j.cats)for(const r of c.results){
 const key=c.cat+'/'+r.id; if(!want.includes(key))continue;
 const fr=r.frames.filter(f=>!f.mark);
 const sp=fr.filter(f=>f.w>15);
 console.log('==',key,'spikes',sp.length);
 const shown=new Set();
 for(const s of sp.slice(0,4)){const i=fr.indexOf(s);for(let k=Math.max(0,i-2);k<=Math.min(fr.length-1,i+1);k++){if(shown.has(k))continue;shown.add(k);const f=fr[k];console.log(f.t,f.clip,'req',f.req,'act',f.act,'w',f.w,f.wb,'pen',f.penMM,f.penPair,'prop',f.propVis,f.propName,'sw',f.sw,'walk',f.walk,'lift',f.lift)}}
 console.log(' marks',r.frames.filter(f=>f.mark).map(f=>f.t+':'+f.mark).join(' | '));
 console.log(' plays',r.plays.map(p=>p.t+':'+p.name+' <'+p.stack.slice(0,70)).join('\n   '));
}
