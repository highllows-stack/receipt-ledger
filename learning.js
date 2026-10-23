'use strict';
// くらしのレシート v0.9: deterministic, no external paid AI services.
// Per-ledger rules are stored in RLS-protected Supabase; local mode stays in localStorage.
const LEARNING_MAX_RULES=1000;
let learningRules=new Map();
let learningAvailable=true;
let learningBusy=false;
const learningEl=id=>document.getElementById(id);
const learningKey=name=>String(name||'').normalize('NFKC').toLowerCase()
  .replace(/[\s\u3000\u200b\-‐―_.,、。・\/\\:：;；()（）\[\]［］{}｛｝*＊+＋#＃￥¥]/g,'').slice(0,200);
function learningValidateCategory(major,minor){return !!(GROUPS[major]&&GROUPS[major].includes(minor))}
function learningRuleFor(item,originalName=item.name,source='edit'){
  const match_key=learningKey(originalName);
  if(!match_key||!item?.name||/^未読み取り[:：]/.test(String(originalName))||!learningValidateCategory(item.category,item.subcategory))return null;
  return{match_key,raw_name:String(originalName).slice(0,300),preferred_name:String(item.name).slice(0,300),
    canonical_name:String(item.canonical||item.name).slice(0,300),major_category:item.category,minor_category:item.subcategory,
    origin:String(item.origin||'').slice(0,200)||null,storage_type:item.state||null,source};
}
function learningStatus(msg){const el=learningEl('learningStatus');if(el)el.textContent=msg}
function learningRefreshUI(){
  if(!learningEl('learningRulesList'))return;
  const list=[...learningRules.values()].sort((a,b)=>String(b.updated_at||'').localeCompare(String(a.updated_at||'')));
  learningEl('learningRuleCount').textContent=list.length+'件の学習ルール';
  learningEl('learningRulesList').innerHTML=list.length?list.map(r=>`<div class="learning-rule"><div><strong>${esc(r.raw_name)}</strong> → ${esc(r.preferred_name)}<br><small>${esc(r.major_category)} ＞ ${esc(r.minor_category)} ／ 統一名：${esc(r.canonical_name)}</small></div><button type="button" class="secondary learning-forget" data-rule="${encodeURIComponent(r.match_key)}">忘れる</button></div>`).join(''):
    '<p class="muted">まだ学習ルールはありません。購入履歴を編集するか「既存履歴から学習」を押してください。</p>';
  learningEl('learningRulesList').querySelectorAll('.learning-forget').forEach(b=>b.onclick=()=>learningDeleteRule(decodeURIComponent(b.dataset.rule)));
}
function learningLocalSync(){
  if(window.cloudMode)return;
  state.learnedRules=[...learningRules.values()];persist();
}
function learningResetLocal(){
  learningRules=new Map((Array.isArray(state.learnedRules)?state.learnedRules:[]).filter(x=>x&&learningKey(x.raw_name)===x.match_key).map(x=>[x.match_key,x]));
  learningAvailable=true;learningRefreshUI();learningRenderPredictions();
}
window.learningOnCloudLoaded=async function(){
  learningRules=new Map();learningAvailable=false;learningRefreshUI();
  try{
    const data=await sbApi('/rest/v1/product_learning_rules?select=*&ledger_id=eq.'+encodeURIComponent(sbLedger)+'&limit=1000');
    learningRules=new Map(data.filter(x=>x.match_key).map(x=>[x.match_key,x]));
    learningAvailable=true;learningStatus('クラウドの学習ルールを読み込みました。PC・スマホで共通です。');
  }catch(e){
    learningStatus('学習ルールを読み込めません：'+e.message+'。追加SQLが未実行か確認してください。購入・集計は通常どおり利用できます。');
  }
  learningRefreshUI();learningRenderPredictions();
};
window.learningOnSignOut=function(){learningResetLocal();learningStatus('端末内の学習ルールを表示中です。')};
function learningHistorySuggestion(raw){
  const key=learningKey(raw);
  if(!key)return null;
  // Prefer user-confirmed/non-generic historical classification; never modify a historical row.
  const candidates=active().flatMap(p=>p.items.filter(i=>learningKey(i.name)===key&&
    learningValidateCategory(i.category,i.subcategory)&&i.category!=='その他').map(i=>({p,i})));
  if(!candidates.length)return null;
  const categories=new Map();
  for(const {i} of candidates){const k=i.category+'\0'+i.subcategory;categories.set(k,(categories.get(k)||0)+1)}
  const best=[...categories].sort((a,b)=>b[1]-a[1]);
  if(best.length>1&&best[0][1]===best[1][1])return null;
  const selected=candidates.find(({i})=>i.category+'\0'+i.subcategory===best[0][0]);
  return selected?{...learningRuleFor(selected.i,raw,'history'),source:'history_derived'}:null;
}
// Exact normalized key only: fuzzy matches risk confusing distinct food products.
window.learningApplyOCRItem=function(item){
  const key=learningKey(item.name);
  if(!key)return {...item,learningMatch:''};
  const rule=learningRules.get(key)||(learningAvailable?learningHistorySuggestion(item.name):null);
  if(!rule||!learningValidateCategory(rule.major_category,rule.minor_category))return {...item,learningMatch:''};
  return {...item,name:rule.preferred_name,canonical:rule.canonical_name,category:rule.major_category,
    subcategory:rule.minor_category,origin:rule.origin||item.origin||'',state:rule.storage_type||item.state||'',
    learningMatch:rule.source==='history_derived'?'履歴から分類':'修正を学習済み'};
};
async function learningSaveRule(rule){
  if(!rule)return false;
  if(window.cloudMode){
    if(!learningAvailable)throw Error('学習用SQLが必要です。設定済みか確認してください');
    const rec={...rule,ledger_id:sbLedger,created_by:learningRules.get(rule.match_key)?.created_by||sbSession.user.id,updated_at:new Date().toISOString()};
    const result=await sbApi('/rest/v1/product_learning_rules?on_conflict=ledger_id,match_key',{method:'POST',data:[rec],extraHeaders:{Prefer:'resolution=merge-duplicates,return=representation'}});
    if(!Array.isArray(result)||!result.length)throw Error('学習内容をクラウドに保存できませんでした');
    learningRules.set(rule.match_key,result[0]);
  }else{
    learningRules.set(rule.match_key,{...rule,updated_at:new Date().toISOString()});
    learningLocalSync();
  }
  learningRefreshUI();return true;
}
window.learningRememberEdit=async function(before,after,enabled=true){
  if(!enabled)return;
  let learned=0,failed=0;
  for(const item of after.items){
    const old=before.items.find(x=>x.id===item.id);
    if(!old)continue;
    const changed=['name','canonical','category','subcategory','origin','state'].some(k=>String(old[k]||'')!==String(item[k]||''));
    if(!changed)continue;
    const originals=new Set([old.name,item.name]);
    for(const oldName of originals){
      const rule=learningRuleFor(item,oldName,'edit');
      if(!rule)continue;
      try{await learningSaveRule(rule);learned++}catch(e){failed++;learningStatus('明細は保存されましたが、学習の保存に失敗：'+e.message);console.error(e)}
    }
  }
  if(learned&&!failed)learningStatus('修正内容を'+learned+'件学習しました。次回のOCRに適用します。');
  learningRenderPredictions();
};
async function learningDeleteRule(key){
  if(!learningRules.has(key)||learningBusy)return;
  if(!confirm('この商品の学習ルールを削除しますか？過去の購入履歴は削除しません。'))return;
  learningBusy=true;
  try{
    if(window.cloudMode){
      if(!learningAvailable)throw Error('クラウドに接続できません');
      await sbApi('/rest/v1/product_learning_rules?ledger_id=eq.'+encodeURIComponent(sbLedger)+'&match_key=eq.'+encodeURIComponent(key),{method:'DELETE'});
    }
    learningRules.delete(key);learningLocalSync();learningRefreshUI();learningStatus('学習ルールを削除しました。');
  }catch(e){learningStatus('削除できません：'+e.message)}finally{learningBusy=false}
}
async function learningImportHistory(){
  if(learningBusy)return;
  if(window.cloudMode&&!learningAvailable)return learningStatus('先に学習機能用SQLを実行してください。');
  const candidates=new Map();
  for(const p of active().slice().sort((a,b)=>String(a.date).localeCompare(String(b.date)))){
    for(const i of p.items){
      if(i.category==='その他'||!learningValidateCategory(i.category,i.subcategory))continue;
      const rule=learningRuleFor(i,i.name,'history');
      if(rule)candidates.set(rule.match_key,rule);
    }
  }
  const eligible=[...candidates.values()].filter(r=>!learningRules.has(r.match_key));
  if(!eligible.length)return learningStatus('新たに学習できる分類済みの商品はありません。');
  if(!confirm('分類済みの購入履歴 '+eligible.length+' 種類を学習します。誤った分類があれば、先に「履歴」で直してください。よろしいですか？'))return;
  learningBusy=true;learningEl('learningImport').disabled=true;let success=0;
  try{
    if(eligible.length+learningRules.size>LEARNING_MAX_RULES)throw Error('学習ルールは最大1000件です。');
    for(const rule of eligible){await learningSaveRule(rule);success++}
    learningStatus('既存履歴から '+success+' 種類を学習しました。お米も分類済みなら含まれます。');
  }catch(e){learningStatus(success+'件を学習後に停止：'+e.message)}finally{
    learningBusy=false;learningEl('learningImport').disabled=false;learningRefreshUI();
  }
}
// Safe predictions: statistical summaries of own ledger history, no external AI calls.
function learningAmountRows(){
  const results=[];
  for(const p of active())for(const i of p.items){
    for(const a of accountingAllocations(p,i)){
      if(monthIsValid(a.month)&&Number.isFinite(Number(a.amount)))
        results.push({month:a.month,amount:Number(a.amount),major:i.category||'その他',minor:i.subcategory||'未分類',name:i.canonical||i.name,item:i,purchase:p});
    }
  }
  return results;
}
function learningPastMonths(target,series){
  const complete=[];
  for(let n=1;n<=6;n++){const month=monthShift(target,-n);const rows=series.filter(x=>x.month===month);
    if(rows.length)complete.push({month,rows,total:rows.reduce((s,r)=>s+r.amount,0)});
  }
  return complete;
}
function learningForecast(target,scope='all'){
  const series=learningAmountRows();
  const scoped=r=>scope==='food'?['食材','調味料','食品・飲料'].includes(r.major):true;
  const known=series.filter(r=>r.month===target&&scoped(r)).reduce((s,r)=>s+r.amount,0);
  const past=learningPastMonths(target,series);
  if(past.length<2)return{available:false,known,samples:past.length,reason:'対象月より前の記録がある月が'+past.length+'か月です。2か月以上になると参考予測を表示します。'};
  const totals=past.map(m=>m.rows.filter(scoped).reduce((s,r)=>s+r.amount,0));
  // Range is from observed months, not a confidence interval.
  const average=totals.reduce((s,v)=>s+v,0)/totals.length;
  const byMajor=new Map();
  for(const m of past)for(const r of m.rows.filter(scoped)){
    const k=r.major;const entries=byMajor.get(k)||new Map();entries.set(m.month,(entries.get(m.month)||0)+r.amount);byMajor.set(k,entries);
  }
  const cats=[...byMajor].map(([name,amounts])=>({name,average:[...past].reduce((s,m)=>s+(amounts.get(m.month)||0),0)/past.length})).sort((a,b)=>b.average-a.average);
  return{available:true,known,samples:past.length,average,range:[Math.min(...totals),Math.max(...totals)],months:past.map(m=>m.month),cats};
}
function learningPriceReference(){
  const byKey=new Map();
  for(const p of active())for(const i of p.items){
    const base=String(i.canonical||i.name).trim();
    if(!base||!Number.isFinite(Number(i.amount))||i.amount<=0)continue;
    const pinfo=unitPrice(i); // v0.8's unit conversion, e.g. 100g / 100ml / per item
    if(!pinfo||!Number.isFinite(pinfo.value)||pinfo.value<=0)continue;
    const key=learningKey(base)+'\0'+pinfo.unit;
    const set=byKey.get(key)||[];set.push({price:pinfo.value,purchase:p,item:i,unit:pinfo.unit,name:base});byKey.set(key,set);
  }
  return [...byKey.values()].filter(rows=>rows.length>=2).map(rows=>{
    const sorted=rows.slice().sort((a,b)=>a.price-b.price);
    const chronological=rows.slice().sort((a,b)=>String(b.purchase.date).localeCompare(String(a.purchase.date)));
    return{name:rows[0].name,unit:rows[0].unit,count:rows.length,minimum:sorted[0].price,maximum:sorted.at(-1).price,
      mean:rows.reduce((s,r)=>s+r.price,0)/rows.length,latest:chronological[0].price};
  }).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'ja')).slice(0,15);
}
function learningAllocationProposal(item,purchaseDate,excludedPurchaseId){
  const key=learningKey(item.canonical||item.name);
  const matches=active().filter(p=>p.id!==excludedPurchaseId).flatMap(p=>p.items
    .filter(i=>learningKey(i.canonical||i.name)===key&&Array.isArray(i.allocations)&&i.allocations.length)
    .map(i=>({p,i})));
  if(matches.length<2)return null;
  const templates=new Map();
  for(const {p,i} of matches){
    const total=Number(i.amount);
    if(!total||!monthIsValid(p.date?.slice(0,7)))continue;
    const offsets=[];
    for(const a of i.allocations){
      if(!monthIsValid(a.month)||!Number.isFinite(Number(a.amount)))continue;
      const off=(Number(a.month.slice(0,4))-Number(p.date.slice(0,4)))*12+Number(a.month.slice(5))-Number(p.date.slice(5,7));
      if(off<0||off>12)continue;
      offsets.push({offset:off,ratio:Number(a.amount)/total});
    }
    if(!offsets.length)continue;
    const sig=offsets.sort((a,b)=>a.offset-b.offset).map(x=>x.offset+':'+Math.round(x.ratio*10)/10).join(';');
    const t=templates.get(sig)||{count:0,offsets};t.count++;templates.set(sig,t);
  }
  const dominant=[...templates.values()].sort((a,b)=>b.count-a.count)[0];
  if(!dominant||dominant.count<2)return null;
  const valid=dominant.offsets.filter(o=>o.ratio>0),sum=valid.reduce((s,o)=>s+o.ratio,0);
  if(!valid.length||sum<=0)return null;
  const total=Math.round(Number(item.amount)*100);
  const amounts=valid.map(o=>Math.floor(total*o.ratio/sum));
  let rest=total-amounts.reduce((s,x)=>s+x,0);for(let k=0;k<rest;k++)amounts[k%amounts.length]++;
  return{samples:matches.length,monthPlans:valid.map((o,k)=>({month:monthShift(purchaseDate.slice(0,7),o.offset),amount:amounts[k]/100,quantity:null}))};
}
window.learningPredictAllocations=learningAllocationProposal;
function learningRenderPredictions(){
  const target=learningEl('learningTargetMonth');if(!target)return;
  const selected=target.value||monthShift(today().slice(0,7),1);
  const whole=learningForecast(selected,'all'),food=learningForecast(selected,'food');
  const dom=learningEl('learningForecast');
  const message=r=>r.available?`<strong>${yen(Math.round(r.average))}</strong><br><small>過去${r.samples}か月の月平均（観測範囲 ${yen(Math.round(r.range[0]))}〜${yen(Math.round(r.range[1]))}）</small>`:
    `<strong>データ不足</strong><br><small>${esc(r.reason)}</small>`;
  dom.innerHTML=`<div class="learning-forecast-grid"><div><small>全支出の参考予測</small>${message(whole)}<small>${esc(selected)}に計上済み：${yen(whole.known)}</small></div><div><small>食費の参考予測</small>${message(food)}<small>${esc(selected)}に計上済み：${yen(food.known)}</small></div></div>`+
    (whole.available?`<div class="learning-forecast-cats"><h4>費目ごとの過去月平均</h4>${whole.cats.map(r=>`<div class="line"><span>${esc(r.name)}</span><strong>${yen(Math.round(r.average))}</strong></div>`).join('')}</div>`:'');
  learningEl('learningPriceStats').innerHTML=(()=>{
    const p=learningPriceReference();
    if(!p.length)return'<p class="muted">同じ統一商品名・同じ単位で、2回以上の購入履歴が必要です。1件だけのお米はまだ価格予測の対象になりません。</p>';
    return p.map(r=>`<div class="learning-price-row"><strong>${esc(r.name)}</strong><small>${r.count}件の実績｜${esc(r.unit)}あたり</small><span>最新 ${yen(Math.round(r.latest*100)/100)} ／ 平均 ${yen(Math.round(r.mean*100)/100)} ／ 最安 ${yen(Math.round(r.minimum*100)/100)}</span></div>`).join('');
  })();
  const proposals=new Map();
  for(const p of active().slice().sort((a,b)=>String(b.date).localeCompare(String(a.date))))for(const i of p.items){
    const k=learningKey(i.canonical||i.name);if(proposals.has(k))continue;
    const plan=learningAllocationProposal(i,today(),null);
    if(plan)proposals.set(k,{name:i.canonical||i.name,plan});
  }
  learningEl('learningMonthStats').innerHTML=proposals.size?[...proposals.values()].slice(0,10).map(({name,plan})=>
    `<div class="learning-price-row"><strong>${esc(name)}</strong><small>過去${plan.samples}件の計上パターンから参考提案</small><span>${plan.monthPlans.map(a=>esc(a.month)+'分 '+yen(a.amount)).join(' ／ ')}（同額購入を仮定）</span></div>`).join(''):
    '<p class="muted">同一商品の月別配分が2件以上蓄積されると、次回の計上月を参考予測できます。編集画面の「過去の配分から提案」でも使用できます。</p>';
}
window.learningRefreshPredictions=learningRenderPredictions;
window.learningExportRules=()=>[...learningRules.values()].map(r=>({...r}));
function learningInit(){
  learningEl('learningImport').onclick=learningImportHistory;
  learningEl('learningTargetMonth').value=monthShift(today().slice(0,7),1);
  learningEl('learningTargetMonth').onchange=learningRenderPredictions;
  if(!window.cloudMode)learningResetLocal();else learningRefreshUI();
  learningStatus('端末内の学習を表示中。クラウドにログインすると学習ルールも同期します。');
}
learningInit();
