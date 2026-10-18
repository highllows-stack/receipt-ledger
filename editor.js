'use strict';
// Purchase editor for both on-device and Supabase records. No schema migration required.
let currentEditPurchase=null;
let purchaseEditorBusy=false;
const editGet=id=>document.getElementById(id);
function editOptions(values,selected){return values.map(v=>`<option value="${esc(v)}"${v===selected?' selected':''}>${esc(v)}</option>`).join('');}
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
</div>`;
  const cat=wrap.querySelector('.e-category'),sub=wrap.querySelector('.e-subcategory');
  function updateSub(selected){sub.innerHTML=editOptions(GROUPS[cat.value],selected||GROUPS[cat.value][0]);}
  updateSub(initialSub);
  cat.addEventListener('change',()=>updateSub());
  wrap.querySelector('.edit-remove').addEventListener('click',()=>{
    if(editGet('editItems').children.length===1)return editStatus('最低1商品の明細が必要です。');
    wrap.remove();editTotals();
  });
  wrap.querySelector('.edit-split').addEventListener('click',()=>{
    if(editGet('editItems').children.length>=100)return editStatus('明細は最大100件です。');
    const draft=editRowData(wrap,false);
    if(!draft)return editStatus('まず商品名と金額を入力してください。');
    const half=Math.floor(draft.amount*100/2)/100;
    if(half<=0)return editStatus('分割するには金額が0円より大きい必要があります。');
    const copy={...draft,id:uid(),amount:Number((draft.amount-half).toFixed(2)),qty:1};
    wrap.querySelector('.e-amount').value=String(half);
    const newRow=editNewRow(copy);
    wrap.after(newRow);editTotals();
    newRow.querySelector('.e-name').focus();
    editStatus('明細を2行に分割しました。各商品の名称・金額・分類・数量を修正して保存してください。');
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
  return{id:row.dataset.id,name,canonical,amount,qty,size,unit:v('e-unit'),
    category:v('e-category'),subcategory:v('e-subcategory'),origin:v('e-origin').trim(),state:v('e-state')};
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
  editGet('editItems').innerHTML='';
  for(const i of p.items){editGet('editItems').append(editNewRow(i));}
  editStatus('商品を編集・追加・分割できます。変更は「変更を保存」を押すまで反映されません。');
  editTotals();
  const dlg=editGet('purchaseEditor');
  if(!dlg.open)dlg.showModal();
  if(focusId){const row=[...editGet('editItems').children].find(r=>r.dataset.id===focusId);row?.querySelector('.e-name')?.focus()}
};
function editClose(){if(purchaseEditorBusy)return;editGet('purchaseEditor').close();currentEditPurchase=null;}
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
    editGet('purchaseEditor').close();currentEditPurchase=null;toast('購入明細を保存しました。');
  }catch(e){editStatus('保存できませんでした：'+e.message+'。履歴を再取得して状態を確認してください。');}
  finally{purchaseEditorBusy=false;editGet('editSave').disabled=false;}
}
function editInit(){
  editGet('editClose').addEventListener('click',editClose);
  editGet('editCancel').addEventListener('click',editClose);
  editGet('editAdd').addEventListener('click',()=>{if(editGet('editItems').children.length>=100)return editStatus('明細は最大100件です。');editGet('editItems').append(editNewRow({name:'',amount:0,qty:1,unit:'個',category:'その他',subcategory:'未分類'}));editTotals();editGet('editItems').lastElementChild.querySelector('.e-name').focus();});
  editGet('editReceiptTotal').addEventListener('input',editTotals);
  editGet('editSave').addEventListener('click',editSave);
  editGet('purchaseEditor').addEventListener('cancel',e=>{if(purchaseEditorBusy)e.preventDefault();else currentEditPurchase=null;});
}
editInit();
