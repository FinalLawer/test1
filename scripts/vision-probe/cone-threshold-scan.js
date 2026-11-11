'use strict';
/* 一次扫出 166 帧的全部候选摘要，再对 flat/mono 阈值做网格评估。
 * 不修改源码，仅替换判据为「只记录」。 */
const fs=require('fs');
const src=fs.readFileSync(require('path').join(require('path').resolve(__dirname, '..', '..'), 'src', 'webview-preload.js'),'utf8');
const h0=src.indexOf('function degOf(ux, uy) {');
const h1=src.indexOf('/* ---------------------------------------------------------------- 扇形通道',h0);
const c0=src.indexOf('function analyzeCone(img, size, step) {');
const c1=src.indexOf('/**\n * 圆形 α-β 滤波',c0);
const H=new Function(src.slice(h0,h1)+';return {degOf,angDiff};')();
let core=src.slice(c0,c1);
/* 2026-11-06 P1 之后 flat/mono 与相对优势不再是硬门槛，改在候选上打标记做历史对照。
 * 不再依赖后面 return 分支的确切文本，直接从 cand.push 收集全部候选。 */
core=core.replace('if (pos < 5 || fade <= 0.03 || all <= 0.02 || inner <= 0.03) continue;','const f1=(pos<5||fade<=0.03||all<=0.02||inner<=0.03);');
core=core.replace('cand.push({ c, score, all, inner, outer, fade, pos, edge, solid, mono, flat, layers });',
                  'const f2=(mono<4||flat<0.62); const _o={c,score,all,inner,outer,fade,pos,edge,solid,mono,flat,layers,f1,f2}; cand.push(_o); DIAG.cand.push(_o);');
const diag=new Function('degOf','angDiff','DIAG',core+';return function(i,s,st){DIAG.cand=[];analyzeCone(i,s,st);return DIAG.cand;};')(H.degOf,H.angDiff,{cand:[]});
const man=JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.json'),'utf8'));
const blob=fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.bin'));
const gate=JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidscan-gate.json'),'utf8'));
const gm=new Map(gate.map(g=>[g.t,g.blob>=8]));
const frames=[];
for(const e of man.list){
  const S=e.size,b=S*S*4;
  const data=new Uint8ClampedArray(blob.buffer.slice(blob.byteOffset+e.off,blob.byteOffset+e.off+b));
  const allCand=diag({data,width:S,height:S},S,man.step);
  frames.push({t:e.t,has:gm.get(e.t)===true,cand:allCand.map(x=>({c:x.c,score:(x.score||0),flat:x.flat,mono:x.mono,pos:x.pos,fade:x.fade,all:x.all,inner:x.inner,f1:x.f1}))});
}
function evaluate(flatMin,monoMin,useRival){
  let hit=0,fp=0,miss=0,tn=0;
  for(const f of frames){
    const ok=f.cand.filter(x=>!x.f1 && x.flat>=flatMin && x.mono>=monoMin).sort((a,b)=>b.score-a.score);
    let valid=false;
    if(ok.length){
      const b=ok[0];
      const rival=useRival ? (ok.find(x=>Math.abs(((x.c-b.c+36+72)%72)-36)>6)||{score:0}).score : 0;
      valid = b.score >= Math.max(0.16, rival*1.18);
    }
    if(f.has&&valid)hit++; else if(f.has)miss++; else if(valid)fp++; else tn++;
  }
  return {flatMin,monoMin,useRival,hit,miss,fp,tn,rate:(100*hit/(hit+miss)).toFixed(1)};
}
console.log('flat   mono  相对优势 | 检出/153  漏检  误检/13  检出率');
console.log('-'.repeat(64));
for(const [fl,mo,rv] of [[0.62,4,true],[0.55,4,true],[0.45,4,true],[0.35,4,true],[0.20,4,true],[0,4,true],
                         [0.45,3,true],[0.20,3,true],[0,3,true],[0,0,true],[0,0,false]]){
  const r=evaluate(fl,mo,rv);
  console.log(`${String(fl).padEnd(6)} ${String(mo).padEnd(6)} ${String(rv).padEnd(9)} | ${String(r.hit).padStart(4)}     ${String(r.miss).padStart(3)}   ${String(r.fp).padStart(3)}     ${r.rate}%`);
}
fs.writeFileSync(require('path').join(require('os').tmpdir(), 'cone-candidates.json'),JSON.stringify(frames));
