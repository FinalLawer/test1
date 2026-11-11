'use strict';
/* 弱监督：镜头连续转动 ⇒ 相邻检出帧角度差应小、大跳应少。
 * 用这个独立指标判断「放宽阈值」有没有把绿弧变成乱指。 */
const fs=require('fs');
const frames=JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'cone-candidates.json'),'utf8'));
const angDiff=(a,b)=>Math.abs(((a-b+540)%360)-180);
function bestAngle(f,flatMin,monoMin,useRival){
  const ok=f.cand.filter(x=>!x.f1&&x.flat>=flatMin&&x.mono>=monoMin).sort((a,b)=>b.score-a.score);
  if(!ok.length)return null;
  const b=ok[0];
  const rival=useRival?(ok.find(x=>angDiff(x.c*5+2.5,b.c*5+2.5)>30)||{score:0}).score:0;
  if(b.score<Math.max(0.16,rival*1.18))return null;
  return {deg:(b.c*5+2.5)%360, score:b.score};
}
function report(name,fl,mo,rv,gate){
  const pts=[];
  for(const f of frames){
    if(gate&&!f.has)continue;
    const a=bestAngle(f,fl,mo,rv);
    if(a)pts.push({t:f.t,deg:a.deg});
  }
  const jumps=[];
  for(let i=1;i<pts.length;i++){
    if(pts[i].t-pts[i-1].t<=4) jumps.push(angDiff(pts[i].deg,pts[i-1].deg));
  }
  jumps.sort((a,b)=>a-b);
  const med=jumps.length?jumps[jumps.length>>1]:999;
  const p90=jumps.length?jumps[Math.floor(jumps.length*0.9)]:999;
  const big=jumps.filter(x=>x>60).length;
  console.log(`${name.padEnd(26)} 检出=${String(pts.length).padStart(3)}  相邻差中位=${med.toFixed(1).padStart(5)}°  p90=${p90.toFixed(1).padStart(5)}°  >60°大跳=${String(big).padStart(2)}/${jumps.length}`);
}
console.log('（相邻差只统计间隔<=4s 的检出帧；镜头连续 ⇒ 差值应小）\n');
report('P1之前 0.62/4/相对优势',0.62,4,true,false);
report('放宽 0.35/4/相对优势',0.35,4,true,false);
report('0/3/相对优势',0,3,true,false);
report('0/0/无相对优势',0,0,false,false);
report('P1之后 0/0/无优势+门控',0,0,false,true);
console.log('\n--- 加门控后各类统计 ---');
for(const [n,fl,mo,rv] of [['P1之前',0.62,4,true],['P1之后',0,0,false]]){
  let hit=0,miss=0,fp=0,tn=0;
  for(const f of frames){
    const a=bestAngle(f,fl,mo,rv);
    const valid=!!a&&f.has;             // 门控：无小地图一律不给绿弧
    if(f.has&&valid)hit++; else if(f.has)miss++; else if(!valid)tn++; else fp++;
  }
  console.log(`${n.padEnd(20)} 检出 ${hit}/153 (${(100*hit/153).toFixed(1)}%)  误检 ${fp}/13`);
}
