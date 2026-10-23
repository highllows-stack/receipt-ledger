'use strict';
// Purchase editor; v0.6 stores monthly allocation plans on each purchase item.
let currentEditPurchase=null;
let purchaseEditorBusy=false;
const editGet=id=>document.getElementById(id);
function editOptions(values,selected){return values.map(v=>`<option value="${esc(v)}"${v===selected?' selected':''}>${esc(v)}</option>`).join('');}
function editAllocationElement(plan){
  const el=document.createElement('div');el.className='accounting-row';
  el.innerHTML=`<label>計上月<input class="a-month" type="month" value="${esc(plan.month||today().slice(0,7))}"></label>
    <label>計上金額（円）<input class="a-amount" type="number" min="0" step="0.01" value="${Number(plan.amount??0)}"></label>
    <label>配分量（任意）<input class="a-qty" type="number" min="0.001" step="0.001" placeholder="例：2" value="${plan.quantity==null?'':Number(plan.quantity)}"></label>
    <button type="button" class="secondary a-remove">削除</button>`;
  el.querySelector('.a-remove').onclick=()=>{
    const parent=el.parentElement;
    if(parent.children.length===1)return editStatus('計上月を最低1件設定してください。');
    el.remove();editTotals();
  };
  el.querySelectorAll('input').forEach(input=>input.addEventListener('input',()=>{
    const wrap=el.closest('.purchase-edit-row');
    if(input.classList.contains('a-amount'))wrap.dataset.autoSingleAmount='no';
    editTotals();
  }));
  return el;
}
function editSetAllocations(wrap,allocations){
  const list=wrap.querySelector('.account-list');list.replaceChildren();
  allocations.forEach(a=>list.append(editAllocationElement(a)));
  wrap.dataset.autoSingleAmount=allocations.length===1?'yes':'no';
  editTotals();
}
function editAllocationSummary(wrap){
  const list=[...wrap.querySelectorAll('.accounting-row')], total=amountCents(wrap.querySelector('.e-amount').value);
  const actual=list.reduce((s,r)=>s+amountCents(r.querySelector('.a-amount').value),0);
  const qtyInputs=list.map(r=>r.querySelector('.a-qty').value.trim());
  const anyQty=qtyInputs.some(Boolean),allQty=qtyInputs.every(Boolean);
  const purchased=accountingTotalQuantity({qty:wrap.querySelector('.e-qty').value,size:wrap.querySelector('.e-size').value||null});
  const unit=wrap.querySelector('.e-unit').value;
  const qtySum=qtyInputs.reduce((s,q)=>s+Number(q||0),0);
  const badQty=anyQty&&(!allQty||Math.abs(qtySum-purchased)>0.001);
  const badAmount=total!==actual;
  const summary=wrap.querySelector('.account-summary');
  summary.classList.toggle('warning',badQty||badAmount);
  summary.textContent=`計上額 ${yen(centsAmount(actual))} / 商品金額 ${yen(centsAmount(total))}`+
    (badAmount?' （金額が一致しません）':' （一致）')+
    (anyQty?`｜配分量 ${Number(qtySum.toFixed(3))} / 購入量 ${Number(purchased.toFixed(3))} ${unit}`+(badQty?' （数量が一致しません）':''):'｜配分量は任意。入力すると合計数量も検証します。');
}
function editAllocationPlan(wrap,name,amount){
  const list=[...wrap.querySelectorAll('.accounting-row')];
  if(!list.length)throw Error(`${name}：計上月を設定してください。`);
  if(list.length>36)throw Error(`${name}：月別配分は最大36件です。`);
  const seen=new Set();let actual=0,qtySum=0,qtyCount=0;
  const alloc=list.map(r=>{
    const month=r.querySelector('.a-month').value;
    const amountText=r.querySelector('.a-amount').value.trim();
    const qtyText=r.querySelector('.a-qty').value.trim();
    const value=Number(amountText);
    if(!monthIsValid(month)||seen.has(month))throw Error(`${name}：計上月が未入力か、同じ月が重複しています。`);
    if(!amountText||!Number.isFinite(value)||value<0||Math.abs(value*100-Math.round(value*100))>0.000001)throw Error(`${name}：計上金額を0円以上、小数第2位までで入力してください。`);
    let quantity=null;
    if(qtyText){quantity=Number(qtyText);if(!Number.isFinite(quantity)||quantity<=0)throw Error(`${name}：配分量を正しく入力してください。`);qtySum+=quantity;qtyCount++}
    seen.add(month);actual+=amountCents(value);
    return{month,amount:centsAmount(amountCents(value)),quantity};
  });
  if(actual!==amountCents(amount))throw Error(`${name}：月別計上金額の合計 ${yen(centsAmount(actual))} と商品金額 ${yen(amount)} が一致しません。`);
  if(qtyCount&&qtyCount!==list.length)throw Error(`${name}：配分量を入力する場合は、すべての月に入力してください。`);
  if(qtyCount){
    const purchased=accountingTotalQuantity({qty:wrap.querySelector('.e-qty').value,size:wrap.querySelector('.e-size').value||null});
    if(Math.abs(qtySum-purchased)>0.001)throw Error(`${name}：配分量の合計 ${qtySum} と購入量 ${purchased} が一致しません。`);
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
    if(!list.length)throw Error('計上月を入力してください。');
    const amounts=list.map(el=>Number(el.querySelector('.a-qty').value));
    if(amounts.some(n=>!Number.isFinite(n)||n<=0))throw Error('すべての月の「配分量」を入力してください。');
    const bought=accountingTotalQuantity({qty:wrap.querySelector('.e-qty').value,size:wrap.querySelector('.e-size').value||null});
    const sum=amounts.reduce((a,b)=>a+b,0);
    if(Math.abs(sum-bought)>0.001)throw Error(`配分量の合計が購入量と異なります。購入量 ${bought} ${wrap.querySelector('.e-unit').value} / 配分量 ${sum}`);
    const fullAmount=Number(wrap.querySelector('.e-amount').value);
    if(!Number.isFinite(fullAmount)||fullAmount<0)throw Error('商品金額を入力してください。');
    const cents=distributeCents(amountCents(fullAmount),amounts);
    list.forEach((el,i)=>el.querySelector('.a-amount').value=String(centsAmount(cents[i])));
    wrap.dataset.autoSingleAmount='no';editTotals();
    editStatus(`数量比で金額を配分しました。保存前に金額を確認してください。`);
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
  <label>容量・重量<input class="e-size" type="number" min="0.001" step="0.001" value="${item.size??''}" placeholder="例：5000"></label>
  <label>単位<select class="e-unit">${editOptions(['g','kg','ml','L','個'],item.unit||'個')}</select></label>
  <label>大分類<select class="e-category">${editOptions(Object.keys(GROUPS),initialCategory)}</select></label>
  <label>小分類<select class="e-subcategory"></select></label>
  <label>産地<input class="e-origin" maxlength="200" value="${esc(item.origin||'')}"></label>
  <label>状態<select class="e-state">${editOptions(['','冷凍','冷蔵','常温'],item.state||'')}</select></label>
</div><div class="account-panel"><header><h4>何月分として計上するか</h4><span class="muted">月別の配分</span></header>
<p class="account-help">購入日とは別に設定できます。分量配分する場合は、容量・重量と単位を入力してください（例：米5kg）。月別の配分量を入力して「数量比で金額を配分」を押します。</p>
<div class="account-list"></div><div class="account-actions"><button type="button" class="secondary a-add">＋月を追加</button><button type="button" class="secondary a-calculate">数量比で金額を自動配分</button><button type="button" class="secondary a-predict">過去の配分から提案</button></div>
<div class="account-summary"></div></div>`;
  const cat=wrap.querySelector('.e-category'),sub=wrap.querySelector('.e-subcategory');
  function updateSub(selected){sub.innerHTML=editOptions(GROUPS[cat.value],selected||GROUPS[cat.value][0]);}
  updateSub(initialSub);
  cat.addEventListener('change',()=>updateSub());
  const defaultMonth=editGet('editDate')?.value.slice(0,7)||currentEditPurchase?.date?.slice(0,7)||today().slice(0,7);
  const initialized=Array.isArray(item.allocations)&&item.allocations.length?item.allocations:[{month:defaultMonth,amount:Number(item.amount||0),quantity:null}];
  const planList=wrap.querySelector('.account-list');
  initialized.forEach(a=>planList.append(editAllocationElement(a)));
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
    planList.append(editAllocationElement({month:next,amount:centsAmount(nextCents),quantity:null}));
    wrap.dataset.autoSingleAmount='no';editTotals();
    planList.lastElementChild.querySelector('.a-month').focus();
  });
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
  const sum=[...editGet('editItems').querySelectorAll('.e-amount')].reduce((v,el)=>v+(Number(el.value)||0),0);
  const total=editGet('editReceiptTotal').value;
  const diff=total===''?null:Number((sum-Number(total)).toFixed(2));
  editGet('editSum').textContent='明細合計：'+yen(sum);
  editGet('editMismatch').textContent=diff===null?'レシート合計が不明の場合は空欄でも保存できます。':
    Math.abs(diff)>0.01?`レシート合計との差：${yen(diff)}（要確認になります）`:'レシート合計と一致しています。';
  editGet('editMismatch').classList.toggle('warning',diff!==null&&Math.abs(diff)>0.01);
  editGet('editItems').querySelectorAll('.purchase-edit-row').forEach(editAllocationSummary);
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
function editClose(){if(purchaseEditorBusy)return;editGet('purchaseEditor').close();currentEditPurchase=null;window.receiptClearPhotoInEditor?.();}
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
    const removed=prior.items.filter(i=>!items.some(n=>n.id===i.id)).map(i=>i.id);
    if(removed.length&&!confirm(`削除する商品が${removed.length}件あります。保存すると商品明細が削除されます。続けますか？`))return;
    edited={...prior,date,merchant,items,receiptTotal:total,
      reviewStatus:mismatch?'needs_review':editGet('editReview').value,updatedAt:new Date().toISOString()};
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
function editInit(){
  editGet('editClose').addEventListener('click',editClose);
  editGet('editCancel').addEventListener('click',editClose);
  editGet('editAdd').addEventListener('click',()=>{if(editGet('editItems').children.length>=100)return editStatus('明細は最大100件です。');editGet('editItems').append(editNewRow({name:'',amount:0,qty:1,unit:'個',category:'その他',subcategory:'未分類'}));editTotals();editGet('editItems').lastElementChild.querySelector('.e-name').focus();});
  editGet('editReceiptTotal').addEventListener('input',editTotals);
  editGet('editSave').addEventListener('click',editSave);
  editGet('purchaseEditor').addEventListener('cancel',e=>{if(purchaseEditorBusy)e.preventDefault();else {currentEditPurchase=null;window.receiptClearPhotoInEditor?.();}});
}
editInit();
