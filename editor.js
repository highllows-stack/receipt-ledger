'use strict';
// Purchase editor; v0.6 stores monthly allocation plans on each purchase item.
let currentEditPurchase=null;
let purchaseEditorBusy=false;
const editGet=id=>document.getElementById(id);
function editOptions(values,selected){return values.map(v=>`<option value="${esc(v)}"${v===selected?' selected':''}>${esc(v)}</option>`).join('');}
// v1.8: physical quantity allocation in a common base unit, with unit-aware input.
// Display unit is stored in the JSONB allocation; quantity remains in the item's base unit.
const EDIT_MASS_UNITS={g:1,kg:1000};
const EDIT_VOLUME_UNITS={ml:1,L:1000};
const EDIT_UNIT_OPTIONS=['g','kg','ml','L','個','本','枚','袋','パック','箱','食','束','粒','杯','切れ','組','セット','缶','瓶','回'];
function editUnitFactor(unit){
  if(Object.hasOwn(EDIT_MASS_UNITS,unit))return {group:'mass',factor:EDIT_MASS_UNITS[unit]};
  if(Object.hasOwn(EDIT_VOLUME_UNITS,unit))return {group:'volume',factor:EDIT_VOLUME_UNITS[unit]};
  return {group:'count:'+unit,factor:1};
}
function editCompatibleUnits(base){
  const kind=editUnitFactor(base).group;
  return EDIT_UNIT_OPTIONS.filter(unit=>editUnitFactor(unit).group===kind);
}
function editConvertAmount(quantity,fromUnit,toUnit){
  const from=editUnitFactor(fromUnit),to=editUnitFactor(toUnit);
  if(from.group!==to.group)throw Error(`単位「${fromUnit}」と「${toUnit}」は換算できません。商品の単位を確認してください。`);
  return quantity*from.factor/to.factor;
}
function editRoundQty(v){return Math.round((v+Number.EPSILON)*1e6)/1e6;}
function editFormatQty(v){return String(editRoundQty(v));}
function editQuantityTotal(wrap){
  const q=Number(wrap.querySelector('.e-qty').value);
  const raw=wrap.querySelector('.e-size').value.trim();
  const size=raw===''?null:Number(raw);
  if(!Number.isFinite(q)||q<=0||size!==null&&(!Number.isFinite(size)||size<=0))return NaN;
  return editRoundQty(q*(size===null?1:size));
}
function editAllocationMode(wrap){return wrap.querySelector('.a-method')?.value||'manual';}
function editAllocationSelectedUnit(el,baseUnit){
  const select=el.querySelector('.a-unit');
  const current=select?.value||baseUnit;
  return editCompatibleUnits(baseUnit).includes(current)?current:baseUnit;
}
function editSetUnitOptions(el,baseUnit,selected){
  const choice=el.querySelector('.a-unit');if(!choice)return;
  const allowed=editCompatibleUnits(baseUnit);
  choice.innerHTML=editOptions(allowed,allowed.includes(selected)?selected:baseUnit);
}
function editApplyMode(wrap){
  const method=editAllocationMode(wrap);
  for(const row of wrap.querySelectorAll('.accounting-row')){
    row.querySelector('.a-fraction-field').hidden=method!=='fraction';
    row.querySelector('.a-quantity-field').hidden=method!=='quantity';
    row.querySelector('.a-row-preview').hidden=method==='manual';
  }
  wrap.querySelector('.a-fraction-calculate').hidden=method!=='fraction';
  wrap.querySelector('.a-calculate').hidden=method!=='quantity';
  const hint=wrap.querySelector('.account-help');
  if(method==='quantity')hint.textContent='商品欄の「数量 × 容量・重量」が購入総量です。各月に使う量を入力し、[使用量から自動配分] を押します。5kgの商品を1,500g＋3,500gのように換算できます。本・個・枚などは商品の単位を選んでください。';
  else if(method==='fraction')hint.textContent='ざっくり「2/5」「3/5」のように各月の割合を入力して [分数から自動配分] を押します。合計が1になる必要があります。';
  else hint.textContent='月別の金額を直接入力します。月の金額を合計すると商品の税込金額に一致する必要があります。';
  editTotals();
}
function editModeForPlans(plans){
  const mode=plans[0]?.allocation_mode;
  if(['quantity','fraction','manual'].includes(mode)&&plans.every(a=>a.allocation_mode===mode))return mode;
  return plans.length&&plans.every(a=>a.quantity!=null&&Number(a.quantity)>0)?'quantity':'manual';
}
function editQuantityWeights(wrap,list,strict=true){
  const base=wrap.querySelector('.e-unit').value;
  const total=editQuantityTotal(wrap);
  if(!Number.isFinite(total)||total<=0)throw Error('購入した総量を「数量」と「容量・重量」で指定してください。例：5kg入り1袋なら、数量1・容量5・単位kgです。');
  const weights=list.map(row=>{
    const field=row.querySelector('.a-qty'),raw=field.value.trim();
    if(!raw)throw Error('すべての月の使用量を入力してください。');
    const v=Number(raw),unit=editAllocationSelectedUnit(row,base);
    if(!Number.isFinite(v)||v<=0)throw Error('使用量は0より大きい数値で入力してください。');
    const normalized=editConvertAmount(v,unit,base);
    if(!Number.isFinite(normalized)||normalized<=0)return NaN;
    return editRoundQty(normalized);
  });
  if(weights.some(v=>!Number.isFinite(v)||v<=0))throw Error('配分量が小さすぎます。少数桁数を減らすか単位を変えてください。');
  const sum=weights.reduce((a,b)=>a+b,0);
  const tolerance=Math.max(0.000001,total*1e-8);
  if(Math.abs(total-sum)>tolerance){
    const unit=base;
    throw Error(`配分した量の合計 ${editFormatQty(sum)}${unit} と、購入した総量 ${editFormatQty(total)}${unit} が一致しません。`);
  }
  return{weights,total};
}
function editInitialFraction(plan,allPlans,totalAmount){
  const physical=allPlans.every(a=>a.quantity!=null)&&allPlans.reduce((n,a)=>n+Number(a.quantity||0),0)>0;
  const numerator=physical?Number(plan.quantity):Number(plan.amount||0);
  const denominator=physical?allPlans.reduce((n,a)=>n+Number(a.quantity||0),0):Number(totalAmount||0);
  if(!Number.isFinite(numerator)||!Number.isFinite(denominator)||denominator<=0||numerator<=0)return'';
  const ratio=numerator/denominator;
  // Find an exact familiar fraction rather than create 952/2380 in the UI.
  for(let d=1;d<=100;d++){
    const n=Math.round(ratio*d);
    if(n>0&&n<=d&&Math.abs(ratio-n/d)<0.000001)return n+'/'+d;
  }
  return'';
}
function editFractionValue(raw){
  const match=String(raw||'').trim().replace(/\s/g,'').match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if(!match)throw Error('配分割合は「2/5」のように「分子/分母」で入力してください。');
  const a=Number(match[1]),b=Number(match[2]);
  if(!Number.isFinite(a)||!Number.isFinite(b)||a<=0||b<=0||a>b)return null;
  return a/b;
}
function editAllocateByFractions(wrap){
  try{
    const list=[...wrap.querySelectorAll('.accounting-row')];
    const ratios=list.map(el=>editFractionValue(el.querySelector('.a-fraction').value));
    if(ratios.some(x=>x===null))throw Error('分数は正の値で、分子は分母以下にしてください。');
    const sum=ratios.reduce((a,b)=>a+b,0);
    if(Math.abs(sum-1)>0.000001)throw Error('分数の合計は1にしてください（例：2/5＋3/5）。現在は '+sum.toFixed(4)+' です。');
    const amount=Number(wrap.querySelector('.e-amount').value);
    if(!Number.isFinite(amount)||amount<0)throw Error('まず商品の税込金額を入力してください。');
    const cents=distributeCents(amountCents(amount),ratios);
    list.forEach((row,i)=>row.querySelector('.a-amount').value=String(centsAmount(cents[i])));
    wrap.dataset.autoSingleAmount='no';editTotals();
    editStatus('分数 '+list.map((row,i)=>row.querySelector('.a-fraction').value).join('＋')+' に従って、'+yen(amount)+'を配分しました。');
  }catch(e){editStatus(e.message)}
}
function editAllocationElement(plan,fraction='',baseUnit='個'){
  const el=document.createElement('div');el.className='accounting-row';
  el.innerHTML=`<label class="a-month-field">計上月<input class="a-month" type="month" value="${esc(plan.month||today().slice(0,7))}"></label>
    <label class="a-amount-field">計上金額（円）<input class="a-amount" type="number" min="0" step="0.01" value="${Number(plan.amount??0)}"></label>
    <label class="a-fraction-field">使用する割合（分数）<input class="a-fraction" type="text" inputmode="text" placeholder="例：2/5" value="${esc(fraction)}"></label>
    <label class="a-quantity-field">この月に使用する量<div class="allocation-qty-control"><input class="a-qty" type="number" min="0.000001" step="any" placeholder="例：1500"><select class="a-unit" aria-label="使用量の単位"></select></div></label>
    <button type="button" class="secondary a-remove">削除</button>
    <small class="a-row-preview"></small>`;
  const chosen=editCompatibleUnits(baseUnit).includes(plan.quantity_unit)?plan.quantity_unit:baseUnit;
  editSetUnitOptions(el,baseUnit,chosen);
  el.querySelector('.a-qty').value=plan.quantity==null?'':editFormatQty(editConvertAmount(Number(plan.quantity),baseUnit,chosen));
  el.querySelector('.a-remove').onclick=()=>{
    const parent=el.parentElement;
    if(parent.children.length===1)return editStatus('計上月を最低1件設定してください。');
    el.remove();editTotals();
  };
  const calcBtn=document.createElement('button');calcBtn.type='button';calcBtn.className='secondary calc-launch';calcBtn.textContent='電卓';
  el.querySelector('.a-amount').after(calcBtn);
  calcBtn.addEventListener('click',()=>editCalculatorOpen(el.querySelector('.a-amount')));
  el.querySelectorAll('input,select').forEach(input=>input.addEventListener('input',()=>{
    const wrap=el.closest('.purchase-edit-row');
    if(input.classList.contains('a-amount'))wrap.dataset.autoSingleAmount='no';
    editTotals();
  }));
  return el;
}
function editSetAllocations(wrap,allocations){
  const list=wrap.querySelector('.account-list');list.replaceChildren();
  const base=wrap.querySelector('.e-unit').value;
  allocations.forEach(a=>list.append(editAllocationElement(a,editInitialFraction(a,allocations,wrap.querySelector('.e-amount').value),base)));
  wrap.querySelector('.a-method').value=editModeForPlans(allocations);
  wrap.dataset.autoSingleAmount=allocations.length===1?'yes':'no';
  editApplyMode(wrap);
}
function editAllocationSummary(wrap){
  const list=[...wrap.querySelectorAll('.accounting-row')],total=amountCents(wrap.querySelector('.e-amount').value);
  const actual=list.reduce((sum,r)=>sum+amountCents(r.querySelector('.a-amount').value),0);
  const mode=editAllocationMode(wrap),base=wrap.querySelector('.e-unit').value;
  const totalQuantity=editQuantityTotal(wrap);
  let detail='',error=false;
  if(mode==='quantity'){
    let sum=0,complete=true;
    for(const row of list){
      const raw=row.querySelector('.a-qty').value.trim();
      const unit=editAllocationSelectedUnit(row,base);
      const n=Number(raw);
      if(!raw||!Number.isFinite(n)||n<=0){complete=false;row.querySelector('.a-row-preview').textContent='使用量を入力してください';continue;}
      const normalized=editConvertAmount(n,unit,base);
      sum+=normalized;
      const percent=Number.isFinite(totalQuantity)&&totalQuantity>0?(100*normalized/totalQuantity).toFixed(1):'?';
      row.querySelector('.a-row-preview').textContent=`${editFormatQty(n)}${unit} / ${editFormatQty(totalQuantity)}${base} (${percent}%)`;
    }
    error=!complete||!Number.isFinite(totalQuantity)||Math.abs(sum-totalQuantity)>Math.max(.000001,totalQuantity*1e-8);
    detail=`｜使用量 ${editFormatQty(sum)}${base} / 購入量 ${editFormatQty(totalQuantity)}${base}`+(error?' （量を確認）':' （一致）');
  }else if(mode==='fraction'){
    let sum=0,complete=true;
    for(const row of list){
      const frac=row.querySelector('.a-fraction').value.trim();
      try{const ratio=editFractionValue(frac);if(ratio===null)throw Error();sum+=ratio;row.querySelector('.a-row-preview').textContent=`${(100*ratio).toFixed(1)}%（${frac}）`;}catch{complete=false;row.querySelector('.a-row-preview').textContent='分数を入力してください'}
    }
    error=!complete||Math.abs(sum-1)>0.000001;
    detail=`｜分数比の合計 ${complete?sum.toFixed(4):'未入力'}`+(error?' （1にしてください）':' （一致）');
  }else detail='｜金額を直接指定';
  const summary=wrap.querySelector('.account-summary');
  summary.classList.toggle('warning',error||actual!==total);
  summary.textContent=`計上額 ${yen(centsAmount(actual))} / 商品金額 ${yen(centsAmount(total))}`+
    (total!==actual?' （金額不一致）':' （一致）')+detail;
}
function editAllocationPlan(wrap,name,amount){
  const list=[...wrap.querySelectorAll('.accounting-row')];
  if(!list.length)throw Error(`${name}：計上月を設定してください。`);
  if(list.length>36)throw Error(`${name}：月別配分は最大36件です。`);
  const method=editAllocationMode(wrap),seen=new Set();let actual=0;
  const alloc=list.map(row=>{
    const month=row.querySelector('.a-month').value;
    const amountText=row.querySelector('.a-amount').value.trim(),value=Number(amountText);
    if(!monthIsValid(month)||seen.has(month))throw Error(`${name}：計上月が空欄か重複しています。`);
    if(!amountText||!Number.isFinite(value)||value<0||Math.abs(value*100-Math.round(value*100))>0.000001)
      throw Error(`${name}：計上金額は0円以上・小数第2位までで入力してください。`);
    seen.add(month);actual+=amountCents(value);
    return{month,amount:centsAmount(amountCents(value)),quantity:null,allocation_mode:method};
  });
  if(actual!==amountCents(amount))throw Error(`${name}：配分額の合計 ${yen(centsAmount(actual))} と商品金額 ${yen(amount)} が一致しません。`);
  if(method==='fraction'){
    const ratios=list.map(row=>editFractionValue(row.querySelector('.a-fraction').value));
    if(ratios.some(v=>v===null)||Math.abs(ratios.reduce((a,b)=>a+b,0)-1)>0.000001)
      throw Error(`${name}：分数の合計を1にしてください（2/5＋3/5など）。`);
    const expected=distributeCents(amountCents(amount),ratios);
    if(list.some((row,i)=>amountCents(row.querySelector('.a-amount').value)!==expected[i]))
      throw Error(`${name}：分数を入力した後、「分数から自動配分」を押して金額を更新してください。`);
    const q=Number(wrap.querySelector('.e-qty').value),hasSize=!!wrap.querySelector('.e-size').value.trim();
    if(hasSize||q>1){
      const total=editQuantityTotal(wrap);if(!Number.isFinite(total)||total<=0)throw Error(`${name}：購入量を確認してください。`);
      const weights=ratios.map((ratio,i)=>i===ratios.length-1?0:editRoundQty(total*ratio));
      weights[weights.length-1]=editRoundQty(total-weights.slice(0,-1).reduce((a,b)=>a+b,0));
      if(weights.some(v=>v<=0))throw Error(`${name}：配分量が小さすぎます。単位か割合を見直してください。`);
      alloc.forEach((a,i)=>{a.quantity=weights[i];a.quantity_unit=wrap.querySelector('.e-unit').value;});
    }
  }else if(method==='quantity'){
    const {weights}=editQuantityWeights(wrap,list);
    const expected=distributeCents(amountCents(amount),weights);
    if(list.some((row,i)=>amountCents(row.querySelector('.a-amount').value)!==expected[i]))
      throw Error(`${name}：「使用量から自動配分」を押して計上金額を更新してください。`);
    alloc.forEach((a,i)=>{a.quantity=weights[i];a.quantity_unit=editAllocationSelectedUnit(list[i],wrap.querySelector('.e-unit').value);});
  }
  return alloc;
}
// Split integer cents according to fractional physical quantities, distributing rounding remainders fairly.
function distributeCents(totalCents,weights){
  const total=weights.reduce((a,b)=>a+b,0);
  if(total<=0)throw Error('配分量を入力してください。');
  const exact=weights.map(w=>totalCents*w/total);
  const cents=exact.map(Math.floor);
  let remaining=totalCents-cents.reduce((a,b)=>a+b,0);
  const sorted=exact.map((v,i)=>({i,part:v-Math.floor(v)})).sort((a,b)=>b.part-a.part);
  for(let i=0;i<remaining;i++)cents[sorted[i].i]++;
  return cents;
}
function editAllocateByQuantity(wrap){
  try{
    const list=[...wrap.querySelectorAll('.accounting-row')];
    const {weights,total}=editQuantityWeights(wrap,list);
    const fullAmount=Number(wrap.querySelector('.e-amount').value);
    if(!Number.isFinite(fullAmount)||fullAmount<0)throw Error('商品金額を入力してください。');
    const cents=distributeCents(amountCents(fullAmount),weights);
    list.forEach((row,i)=>{
      row.querySelector('.a-amount').value=String(centsAmount(cents[i]));
      row.querySelector('.a-fraction').value=editInitialFraction({quantity:weights[i]},weights.map(quantity=>({quantity})),fullAmount);
    });
    wrap.dataset.autoSingleAmount='no';editTotals();
    editStatus(`使用量の合計 ${editFormatQty(total)}${wrap.querySelector('.e-unit').value} を確認し、${yen(fullAmount)}を各月に配分しました。`);
  }catch(e){editStatus(e.message)}
}
function editSplitAllocationPlans(plans,targetCents){
  const base=plans.map(a=>amountCents(a.amount));
  const left=distributeCents(targetCents,base);
  return [plans.map((a,i)=>({...a,amount:centsAmount(left[i]),quantity:a.quantity==null?null:a.quantity/2})),
    plans.map((a,i)=>({...a,amount:centsAmount(base[i]-left[i]),quantity:a.quantity==null?null:a.quantity/2}))];
}

function editNewRow(item={}){
  const wrap=document.createElement('section');
  wrap.className='purchase-edit-row';
  wrap.dataset.id=item.id||uid();
  const initialCategory=GROUPS[item.category]?item.category:'その他';
  const initialSub=GROUPS[initialCategory].includes(item.subcategory)?item.subcategory:GROUPS[initialCategory][0];
  wrap.innerHTML=`<div class="item-head"><strong class="edit-item-label">商品明細</strong><div class="edit-row-actions"><button type="button" class="secondary edit-split">この明細を分割</button><button type="button" class="remove edit-remove">削除</button></div></div>
<div class="item-grid">
  <label class="wide">商品名<input class="e-name" required maxlength="300" value="${esc(item.name||'')}"></label>
  <label class="wide">統一商品名<input class="e-canonical" maxlength="300" value="${esc(item.canonical||'')}"></label>
  <label>税込金額（円）<input class="e-amount" required type="number" min="0" step="0.01" value="${Number.isFinite(Number(item.amount))?esc(item.amount):''}"></label>
  <label>数量<input class="e-qty" required type="number" min="0.001" step="0.001" value="${item.qty??1}"></label>
  <label>1購入単位あたりの容量・本数など<input class="e-size" type="number" min="0.001" step="0.001" value="${item.size??''}" placeholder="例：5000"></label>
  <label>単位<select class="e-unit">${editOptions(EDIT_UNIT_OPTIONS,item.unit||'個')}</select></label>
  <label>大分類<select class="e-category">${editOptions(Object.keys(GROUPS),initialCategory)}</select></label>
  <label>小分類<select class="e-subcategory"></select></label>
  <label>産地<input class="e-origin" maxlength="200" value="${esc(item.origin||'')}"></label>
  <label>状態<select class="e-state">${editOptions(['','冷凍','冷蔵','常温'],item.state||'')}</select></label>
</div><div class="account-panel"><header><h4>何月分として計上するか</h4><span class="muted">月別の配分</span></header>
<label class="allocation-method-label">分け方を選択<select class="a-method"><option value="quantity">実際の量で分ける（g・kg・本・個など）</option><option value="fraction">割合で分ける（2/5・3/5など）</option><option value="manual">金額を直接入力する</option></select></label>
<p class="account-help">分け方を選んでください。</p>
<div class="account-list"></div><div class="account-actions"><button type="button" class="secondary a-add">＋月を追加</button><button type="button" class="secondary a-fraction-calculate">分数から自動配分</button><button type="button" class="secondary a-calculate">使用量から自動配分</button><button type="button" class="secondary a-predict">過去の配分から提案</button></div>
<div class="account-summary"></div></div>`;
  const amountInput=wrap.querySelector('.e-amount');
  // Every purchased item has its OWN calculator. Keep it inside this item's card
  // (not the global floating calculator which can obscure the receipt photograph).
  const amountButton=document.createElement('button');
  amountButton.type='button';amountButton.className='secondary calc-launch';amountButton.textContent='🧮 この商品の電卓';
  amountInput.after(amountButton);
  const ownCalculator=document.createElement('section');
  ownCalculator.className='item-inline-calculator';ownCalculator.hidden=true;
  ownCalculator.setAttribute('aria-label','商品別の計算機');
  ownCalculator.innerHTML=`<div class="item-calc-head"><strong>この商品の電卓</strong><button type="button" class="secondary inline-close" aria-label="電卓を閉じる">閉じる</button></div>
    <label>計算式（税抜・割引にも対応）<input type="text" class="inline-expr" inputmode="decimal" autocomplete="off" placeholder="例：384-116"></label>
    <div class="item-calc-discount"><label>割引方法<select class="inline-discount-mode"><option value="percent">％引き</option><option value="yen">円引き</option></select></label><label>割引率・割引額<input class="inline-discount-value" type="number" min="0" step="any" inputmode="decimal" placeholder="例：20"></label><button type="button" class="secondary inline-discount-apply">式に割引を反映</button></div>
    <div class="item-calc-quick"><button type="button" class="secondary inline-tax8">式の結果に8％を加える</button><button type="button" class="secondary inline-tax10">式の結果に10％を加える</button></div>
    <div class="item-calc-preview" role="status" aria-live="polite">計算式を入力して「計算」を押してください。</div>
    <div class="item-calc-actions"><button type="button" class="secondary inline-equals">＝ 計算</button><button type="button" class="inline-apply">この商品に入力する</button></div>
    <small class="muted">税込額は整数円に四捨五入します。レシート印字額と一致するか最後に確認してください。</small>`;
  amountInput.closest('label').after(ownCalculator);
  const exp=ownCalculator.querySelector('.inline-expr'),preview=ownCalculator.querySelector('.item-calc-preview');
  function evaluateInline(){
    try{
      const v=editCalcEvaluate(exp.value);
      const result=Math.round(v);
      if(result<0||!Number.isSafeInteger(result))throw Error('0円以上の金額を指定してください。');
      preview.textContent='計算結果 '+yen(result);
      return result;
    }catch(err){preview.textContent='計算できません：'+err.message;return null;}
  }
  function toggleInline(){
    const willOpen=ownCalculator.hidden;
    wrap.querySelectorAll('.item-inline-calculator').forEach(x=>{x.hidden=true});
    ownCalculator.hidden=!willOpen;
    if(willOpen){exp.value=amountInput.value||'';preview.textContent='式を入力して「計算」を押してください。';exp.focus();}
  }
  amountButton.addEventListener('click',toggleInline);
  ownCalculator.querySelector('.inline-close').addEventListener('click',()=>{ownCalculator.hidden=true;amountButton.focus();});
  ownCalculator.querySelector('.inline-equals').addEventListener('click',evaluateInline);
  ownCalculator.querySelector('.inline-apply').addEventListener('click',()=>{
    const n=evaluateInline();if(n===null)return;
    amountInput.value=String(n);amountInput.dispatchEvent(new Event('input',{bubbles:true}));
    ownCalculator.hidden=true;editStatus('商品「'+wrap.querySelector('.e-name').value+'」を'+yen(n)+'に更新しました。');
  });
  function withTax(rate){
    const current=exp.value.trim();if(!current)return;
    exp.value='('+current+')*'+(1+rate/100).toFixed(2);
    evaluateInline();
  }
  ownCalculator.querySelector('.inline-tax8').addEventListener('click',()=>withTax(8));
  ownCalculator.querySelector('.inline-tax10').addEventListener('click',()=>withTax(10));
  ownCalculator.querySelector('.inline-discount-apply').addEventListener('click',()=>{
    const current=exp.value.trim(), mode=ownCalculator.querySelector('.inline-discount-mode').value;
    const value=Number(ownCalculator.querySelector('.inline-discount-value').value);
    if(!current||!Number.isFinite(value)||value<0||(mode==='percent'&&value>100)||ownCalculator.querySelector('.inline-discount-value').value.trim()===''){
      preview.textContent='割引前の計算式と、正しい割引率（0～100％）または割引額を入力してください。';return;
    }
    try{
      const base=editCalcEvaluate(current);
      if(base<0||(mode==='yen'&&value>base))throw Error('割引額は商品金額以下にしてください。');
      exp.value=mode==='percent'?`(${current})*(1-${value}/100)`:`(${current})-${value}`;
      evaluateInline();
    }catch(err){preview.textContent='割引を適用できません：'+err.message;}
  });
  exp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();ownCalculator.querySelector('.inline-apply').click();}});
  const cat=wrap.querySelector('.e-category'),sub=wrap.querySelector('.e-subcategory');
  function updateSub(selected){sub.innerHTML=editOptions(GROUPS[cat.value],selected||GROUPS[cat.value][0]);}
  updateSub(initialSub);
  cat.addEventListener('change',()=>updateSub());
  const defaultMonth=editGet('editDate')?.value.slice(0,7)||currentEditPurchase?.date?.slice(0,7)||today().slice(0,7);
  const initialized=Array.isArray(item.allocations)&&item.allocations.length?item.allocations:[{month:defaultMonth,amount:Number(item.amount||0),quantity:null}];
  const planList=wrap.querySelector('.account-list');
  initialized.forEach(a=>planList.append(editAllocationElement(a,editInitialFraction(a,initialized,item.amount),item.unit||'個')));
  wrap.querySelector('.a-method').value=editModeForPlans(initialized);
  editApplyMode(wrap);
  wrap.dataset.autoSingleAmount=initialized.length===1?'yes':'no';
  wrap.querySelector('.a-add').addEventListener('click',()=>{
    const current=[...planList.children];if(current.length>=36)return editStatus('月の配分は最大36件です。');
    const previous=current[current.length-1],next=monthShift(previous.querySelector('.a-month').value,1);
    let nextCents=0;
    if(current.length===1){
      const prevAmount=amountCents(previous.querySelector('.a-amount').value);
      nextCents=Math.floor(prevAmount/2);
      previous.querySelector('.a-amount').value=String(centsAmount(prevAmount-nextCents));
    }
    planList.append(editAllocationElement({month:next,amount:centsAmount(nextCents),quantity:null},'',wrap.querySelector('.e-unit').value));
    planList.querySelectorAll('.a-fraction').forEach(x=>x.value='');
    wrap.dataset.autoSingleAmount='no';editApplyMode(wrap);
    planList.lastElementChild.querySelector('.a-month').focus();
  });
  wrap.querySelector('.a-method').addEventListener('change',()=>{
    if(editAllocationMode(wrap)==='fraction'){
      const parts=[...wrap.querySelectorAll('.accounting-row')];
      const plans=parts.map(row=>({amount:Number(row.querySelector('.a-amount').value),quantity:null}));
      parts.forEach((row,i)=>{if(!row.querySelector('.a-fraction').value.trim())row.querySelector('.a-fraction').value=editInitialFraction(plans[i],plans,Number(wrap.querySelector('.e-amount').value));});
    }
    editApplyMode(wrap);
  });
  wrap.querySelector('.e-unit').addEventListener('change',()=>{
    const base=wrap.querySelector('.e-unit').value;
    for(const row of planList.children){editSetUnitOptions(row,base,base);row.querySelector('.a-qty').value='';}
    editApplyMode(wrap);editStatus('商品単位を変更しました。実際の量で分ける場合は各月の使用量を入力し直してください。');
  });
  wrap.querySelector('.a-fraction-calculate').addEventListener('click',()=>editAllocateByFractions(wrap));
  wrap.querySelector('.a-calculate').addEventListener('click',()=>editAllocateByQuantity(wrap));
  wrap.querySelector('.a-predict').addEventListener('click',()=>{
    let item;try{item=editRowData(wrap,true)}catch(e){return editStatus(e.message)}
    const date=editGet('editDate').value;
    const plan=window.learningPredictAllocations?.(item,date,currentEditPurchase?.id);
    if(!plan)return editStatus('同じ商品の配分履歴が2件以上ありません。参考予測はまだできません。');
    if(!confirm('過去'+plan.samples+'件の配分から予測した計上月に置き換えます。保存前に内容を確認してください。'))return;
    editSetAllocations(wrap,plan.monthPlans);
    editStatus('過去の配分に基づく提案を反映しました。必ず内容を確認して保存してください。');
  });
  wrap.querySelector('.e-amount').addEventListener('input',()=>{
    if(planList.children.length===1&&wrap.dataset.autoSingleAmount==='yes'){
      planList.firstElementChild.querySelector('.a-amount').value=wrap.querySelector('.e-amount').value;
    }
    editTotals();
  });
  wrap.querySelector('.edit-remove').addEventListener('click',()=>{
    if(editGet('editItems').children.length===1)return editStatus('最低1商品の明細が必要です。');
    wrap.remove();editTotals();
  });
  wrap.querySelector('.edit-split').addEventListener('click',()=>{
    if(editGet('editItems').children.length>=100)return editStatus('明細は最大100件です。');
    let draft;
    try{draft=editRowData(wrap,true);}catch(e){return editStatus(e.message);}
    const halfCents=Math.floor(amountCents(draft.amount)/2);
    if(halfCents<=0)return editStatus('分割するには商品金額が0円より大きい必要があります。');
    const qty=draft.qty/2;
    if(qty<0.001)return editStatus('購入数量が小さすぎて明細を分割できません。');
    const [left,right]=editSplitAllocationPlans(draft.allocations,halfCents);
    const copy={...draft,id:uid(),amount:centsAmount(amountCents(draft.amount)-halfCents),qty,allocations:right};
    wrap.querySelector('.e-amount').value=String(centsAmount(halfCents));
    wrap.querySelector('.e-qty').value=String(qty);
    editSetAllocations(wrap,left);
    const newRow=editNewRow(copy);
    wrap.after(newRow);editTotals();
    newRow.querySelector('.e-name').focus();
    editStatus('明細を2行に分割しました。月別配分も金額に合わせて分割しました。必要に応じて各行の数量・品名・配分を修正してください。');
  });
  wrap.querySelectorAll('input,select').forEach(el=>el.addEventListener('input',editTotals));
  return wrap;
}
function editStatus(msg){editGet('editStatus').textContent=msg;}
function editTotals(){
  const rows=[...editGet('editItems').querySelectorAll('.purchase-edit-row')];
  const sum=rows.reduce((v,row)=>v+(Number(row.querySelector('.e-amount')?.value)||0),0);
  const hasUnknown=rows.some(row=>/未読み取り|確認して入力/.test(row.querySelector('.e-name')?.value||''));
  const printed=editGet('editReceiptTotal').value;
  const total=printed===''?null:Number(printed);
  const diff=total===null?null:Math.round((total-sum)*100)/100;
  editGet('editSum').textContent='商品明細の税込合計：'+yen(sum)+(total===null?'':' ／ レシート合計：'+yen(total));
  let message=diff===null?'レシートの合計を確認して入力してください。':
    Math.abs(diff)>.01?(diff>0?`印字合計に対して ${yen(diff)} 不足しています。商品や税・割引の読み落としを確認してください。`:`印字合計より ${yen(-diff)} 超過しています。小計・カード番号・商品重複を確認してください。`):
    '税込明細の合計とレシート合計が一致しています。';
  if(hasUnknown)message+=' 未読み取りの仮明細があります。';
  editGet('editMismatch').textContent=message;
  editGet('editMismatch').classList.toggle('warning',diff===null||Math.abs(diff)>.01||hasUnknown);
  rows.forEach(editAllocationSummary);
}
function editRowData(row,strict=true){
  const v=cls=>row.querySelector('.'+cls).value;
  const name=v('e-name').trim(), canonical=v('e-canonical').trim()||name;
  const amount=v('e-amount').trim()===''?NaN:Number(v('e-amount'));
  const qty=v('e-qty').trim()===''?NaN:Number(v('e-qty'));
  const size=v('e-size').trim()===''?null:Number(v('e-size'));
  if(!name||!Number.isFinite(amount)||amount<0||!Number.isFinite(qty)||qty<=0||
    size!==null&&(!Number.isFinite(size)||size<=0)){
    if(strict)throw Error('商品名・金額・数量・容量を確認してください。');
    return null;
  }
  if(amount>999999999||qty>999999999)return strict?(()=>{throw Error('数値が大きすぎます')})():null;
  let allocations;
  try{allocations=editAllocationPlan(row,name,amount);}catch(e){if(strict)throw e;return null;}
  return{id:row.dataset.id,name,canonical,amount,qty,size,unit:v('e-unit'),
    category:v('e-category'),subcategory:v('e-subcategory'),origin:v('e-origin').trim(),state:v('e-state'),allocations};
}
window.openPurchaseEditor=function(pid,focusId){
  if(editGet('editCalculator'))editCalculatorClose();
  if(purchaseEditorBusy)return;
  const p=state.purchases.find(x=>x.id===pid&&x.bookId===state.activeBook);
  if(!p)return toast('購入履歴が見つかりませんでした。');
  currentEditPurchase=structuredClone(p);
  editGet('editStore').value=p.merchant||'';
  editGet('editDate').value=p.date||today();
  editGet('editReceiptTotal').value=p.receiptTotal??'';
  editGet('editReview').value=p.reviewStatus==='needs_review'?'needs_review':'ok';
  editGet('editLearnChanges').checked=true;
  editGet('editItems').innerHTML='';
  for(const i of p.items){editGet('editItems').append(editNewRow(i));}
  editStatus('商品を編集・追加・分割できます。変更は「変更を保存」を押すまで反映されません。');
  editTotals();
  const dlg=editGet('purchaseEditor');
  if(!dlg.open)dlg.showModal();
  window.receiptShowPhotoInEditor?.(p);
  if(focusId){const row=[...editGet('editItems').children].find(r=>r.dataset.id===focusId);row?.querySelector('.e-name')?.focus()}
};
function editClose(){if(purchaseEditorBusy)return;editCalculatorClose();editGet('purchaseEditor').close();currentEditPurchase=null;window.receiptClearPhotoInEditor?.();}
async function editSave(){
  if(!currentEditPurchase||purchaseEditorBusy)return;
  const prior=currentEditPurchase;
  let edited;
  try{
    const items=[...editGet('editItems').children].map(row=>editRowData(row,true));
    if(!items.length)throw Error('商品明細を1つ以上入力してください。');
    const date=editGet('editDate').value;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('購入日を入力してください。');
    const merchant=editGet('editStore').value.trim()||'購入先未設定';
    const totalText=editGet('editReceiptTotal').value.trim();
    const total=totalText===''?null:Number(totalText);
    if(total!==null&&(!Number.isFinite(total)||total<0))throw Error('レシート合計の金額を確認してください。');
    const sum=items.reduce((v,i)=>v+i.amount,0);
    const mismatch=total!==null&&Math.abs(sum-total)>0.01;
    const unresolved=items.some(i=>/未読み取り|確認して入力/.test(i.name)||(!i.amount&&i.category==='その他')); 
    const removed=prior.items.filter(i=>!items.some(n=>n.id===i.id)).map(i=>i.id);
    if(removed.length&&!confirm(`削除する商品が${removed.length}件あります。保存すると商品明細が削除されます。続けますか？`))return;
    edited={...prior,date,merchant,items,receiptTotal:total,receiptOcrText:currentEditPurchase.receiptOcrText||prior.receiptOcrText||'',
      reviewStatus:mismatch||unresolved?'needs_review':editGet('editReview').value,updatedAt:new Date().toISOString()};
  }catch(e){editStatus(e.message);return;}
  purchaseEditorBusy=true;editGet('editSave').disabled=true;editStatus('保存中です…');
  try{
    if(window.cloudMode){
      if(typeof window.cloudSaveEditedPurchase!=='function')throw Error('クラウド編集機能が見つかりません。再読み込みしてください');
      await window.cloudSaveEditedPurchase(prior,edited);
    }else{
      const at=state.purchases.findIndex(p=>p.id===prior.id&&p.bookId===prior.bookId);
      if(at<0)throw Error('編集対象が見つかりません');
      state.purchases[at]=edited;persist();refresh();
    }
    if(window.learningRememberEdit)await window.learningRememberEdit(prior,edited,editGet('editLearnChanges').checked);
    editGet('purchaseEditor').close();currentEditPurchase=null;window.receiptClearPhotoInEditor?.();toast('購入明細を保存しました。');
  }catch(e){editStatus('保存できませんでした：'+e.message+'。履歴を再取得して状態を確認してください。');}
  finally{purchaseEditorBusy=false;editGet('editSave').disabled=false;}
}
// Safe inline calculator: no eval() and no external service.
let editCalcTarget=null;
function editCalcEvaluate(text){
  const src=String(text||'').replace(/[×ｘ]/g,'*').replace(/[÷]/g,'/').replace(/[−－]/g,'-').replace(/\s/g,'');
  if(!/^[\d.+\-*/()]+$/.test(src)||src.length>120)throw Error('数字と + − × ÷（ ）だけを使ってください。');
  let index=0;
  const factor=()=>{
    if(src[index]==='+'){index++;return factor();}
    if(src[index]==='-'){index++;return -factor();}
    if(src[index]==='('){index++;const n=expr();if(src[index++]!==')')throw Error('括弧を確認してください。');return n;}
    const m=src.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if(!m)throw Error('式を確認してください。');index+=m[0].length;return Number(m[0]);
  };
  const term=()=>{let n=factor();while(src[index]==='*'||src[index]==='/'){const op=src[index++],v=factor();if(op==='/'&&v===0)throw Error('0では割れません。');n=op==='*'?n*v:n/v;}return n;};
  const expr=()=>{let n=term();while(src[index]==='+'||src[index]==='-'){const op=src[index++],v=term();n=op==='+'?n+v:n-v;}return n;};
  const result=expr();if(index!==src.length||!Number.isFinite(result)||Math.abs(result)>1e9)throw Error('式または計算結果を確認してください。');
  return result;
}
function editCalculatorOpen(target){
  if(!target||!editGet('editCalculator'))return;
  editCalcTarget=target;
  editGet('editCalculator').hidden=false;
  editGet('editCalculatorExpr').value=target.value||'';
  editGet('editCalculatorTarget').textContent=target.classList.contains('a-amount')?'月別の計上金額':target.classList.contains('e-amount')?'商品の税込金額':'レシート合計';
  editGet('editCalculatorResult').textContent='式を入力して「＝」で計算してください。';
  editGet('editCalculatorExpr').focus();
}
function editCalculatorClose(){editGet('editCalculator').hidden=true;editCalcTarget=null;}
function editCalculatorResult(apply=false){
  try{
    const value=editCalcEvaluate(editGet('editCalculatorExpr').value);
    const result=editGet('editCalculatorRound').checked?Math.round(value):Math.round(value*100)/100;
    if(result<0)throw Error('金額は0円以上にしてください。');
    editGet('editCalculatorResult').textContent='計算結果 '+yen(result);
    if(apply){if(!editCalcTarget||!editCalcTarget.isConnected)throw Error('金額欄を先に選択してください。');
      editCalcTarget.value=String(result);
      editCalcTarget.dispatchEvent(new Event('input',{bubbles:true}));
      editCalculatorClose();editStatus('電卓の計算結果 '+yen(result)+' を金額欄に入力しました。');}
    return result;
  }catch(e){editGet('editCalculatorResult').textContent='計算できません：'+e.message;return null;}
}
function editCalculatorInit(){
  const root=editGet('editCalculator');if(!root)return;
  editGet('editCalculatorClose').onclick=editCalculatorClose;
  editGet('editCalculatorApply').onclick=()=>editCalculatorResult(true);
  editGet('editCalculatorEquals').onclick=()=>{const v=editCalculatorResult();if(v!==null)editGet('editCalculatorExpr').value=String(v);};
  editGet('editCalculatorTax8').onclick=()=>{const ex=editGet('editCalculatorExpr');ex.value='('+ex.value+')*1.08';editCalculatorResult();};
  editGet('editCalculatorTax10').onclick=()=>{const ex=editGet('editCalculatorExpr');ex.value='('+ex.value+')*1.10';editCalculatorResult();};
  root.querySelectorAll('[data-calc-key]').forEach(b=>b.addEventListener('click',()=>{const el=editGet('editCalculatorExpr');el.value+=b.dataset.calcKey;el.focus();}));
  editGet('editCalculatorBack').onclick=()=>{const el=editGet('editCalculatorExpr');el.value=el.value.slice(0,-1);el.focus();};
  editGet('editCalculatorClear').onclick=()=>{editGet('editCalculatorExpr').value='';editGet('editCalculatorExpr').focus();};
  editGet('editCalculatorExpr').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();editCalculatorResult(true)}if(e.key==='Escape'){e.preventDefault();editCalculatorClose();}});
  editGet('editCalculatorToggle').onclick=()=>{if(!root.hidden){editCalculatorClose();return;}editCalculatorOpen(editCalcTarget||editGet('editReceiptTotal'));};
  editGet('editItems').addEventListener('focusin',e=>{if(!root.hidden&&e.target.matches?.('.e-amount,.a-amount')&&editCalcTarget!==e.target)editCalculatorOpen(e.target);});
  editGet('editReceiptTotal').addEventListener('focus',()=>{if(!root.hidden)editCalculatorOpen(editGet('editReceiptTotal'));});
}
function editInit(){
  editCalculatorInit();
  editGet('editClose').addEventListener('click',editClose);
  editGet('editCancel').addEventListener('click',editClose);
  editGet('editAdd').addEventListener('click',()=>{if(editGet('editItems').children.length>=100)return editStatus('明細は最大100件です。');editGet('editItems').append(editNewRow({name:'',amount:0,qty:1,unit:'個',category:'その他',subcategory:'未分類'}));editTotals();editGet('editItems').lastElementChild.querySelector('.e-name').focus();});
  editGet('editReceiptTotal').addEventListener('input',editTotals);
  editGet('editSave').addEventListener('click',editSave);
  editGet('purchaseEditor').addEventListener('cancel',e=>{if(purchaseEditorBusy)e.preventDefault();else {currentEditPurchase=null;window.receiptClearPhotoInEditor?.();}});
}
editInit();
