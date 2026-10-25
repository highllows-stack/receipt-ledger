'use strict';
// Browser-safe Supabase configuration. Never place a secret/service_role key here.
const SB_URL='https://javznmfmrahigswpkgxz.supabase.co';
const SB_PUBLISHABLE='sb_publishable_U8m7_Byz3bJUllmwPwXwEg_oK4Az7H9';
const SB_SESSION_KEY='receipt-ledger-supabase-session-v03';
let sbSession=null, sbLedger=null, sbLocal=null, sbCategories=[], sbBusy=false;
window.cloudMode=false;
function sbStatus(msg){$('cloudStatus').textContent=msg;}
function sbSessionStore(v){sbSession=v;if(v)localStorage.setItem(SB_SESSION_KEY,JSON.stringify(v));else localStorage.removeItem(SB_SESSION_KEY);}
async function sbApi(endpoint,{method='GET',data=null,extraHeaders={}}={},authenticated=true){
  if(authenticated && sbSession?.expires_at && Date.now()/1000>sbSession.expires_at-90)await sbRefresh();
  const headers={'apikey':SB_PUBLISHABLE,...extraHeaders};
  if(authenticated && sbSession?.access_token)headers.Authorization='Bearer '+sbSession.access_token;
  if(data!==null)headers['Content-Type']='application/json';
  const res=await fetch(SB_URL+endpoint,{method,headers,body:data===null?undefined:JSON.stringify(data)});
  let val;const raw=await res.text();try{val=raw?JSON.parse(raw):null}catch{val=raw;}
  if(!res.ok)throw new Error(val?.message||val?.msg||val?.error_description||val?.error||('HTTP '+res.status));
  return val;
}
async function sbRefresh(){
  if(!sbSession?.refresh_token)throw Error('セッションが切れました。ログインし直してください。');
  const result=await sbApi('/auth/v1/token?grant_type=refresh_token',{method:'POST',data:{refresh_token:sbSession.refresh_token}},false);
  sbSessionStore({...result,expires_at:Math.floor(Date.now()/1000)+result.expires_in});
}
function sbUi(on){
  $('cloudAuth').hidden=on;$('cloudSigned').hidden=!on;
  $('cloudUser').textContent=on?(sbSession?.user?.email||'ログイン中'):'';
  $('book').disabled=on;$('addBook').disabled=on;
}
async function sbAuth(signup){
  if(sbBusy)return;
  const email=$('cloudEmail').value.trim(),password=$('cloudPassword').value;
  if(!email||!password){sbStatus('メールアドレスとパスワードを入力してください。');return;}
  sbStatus('認証しています…');
  try{
    const response=await sbApi(signup?'/auth/v1/signup':'/auth/v1/token?grant_type=password',
      {method:'POST',data:{email,password}},false);
    if(!response.access_token){sbStatus('確認メールが届く場合は、メール内のリンクを開いてからログインしてください。');return;}
    sbSessionStore({...response,expires_at:Math.floor(Date.now()/1000)+response.expires_in});
    await sbLoad();
    $('cloudPassword').value='';
  }catch(e){sbStatus('認証できませんでした：'+e.message);}
}
async function sbReadAll(table,query){
  const output=[];
  for(let offset=0;offset<10000;offset+=500){
    const sep=query.includes('?')?'&':'?';
    const rows=await sbApi('/rest/v1/'+table+query+sep+'limit=500&offset='+offset);
    output.push(...rows);
    if(rows.length<500)return output;
  }
  throw Error('購入履歴が上限を超えました。読み込みを中断しました。');
}
async function sbLoad(){
  if(sbBusy)return;
  sbBusy=true;sbStatus('クラウドから読み込み中…');
  try{
    const me=sbSession.user.id;
    const membership=await sbApi('/rest/v1/ledger_members?select=ledger_id,role&user_id=eq.'+encodeURIComponent(me));
    const ledgers=await sbApi('/rest/v1/ledgers?select=id,name,kind&order=created_at.asc');
    const myPersonal=ledgers.find(l=>l.kind==='personal'&&membership.some(m=>m.ledger_id===l.id));
    if(!myPersonal)throw Error('個人用家計簿がありません。初期SQLを確認してください。');
    const lid=myPersonal.id;
    const [ps,items,categories]=await Promise.all([
      sbReadAll('purchases','?select=*&ledger_id=eq.'+lid+'&order=purchased_at.desc'),
      sbReadAll('purchase_items','?select=*&ledger_id=eq.'+lid),
      sbReadAll('categories','?select=id,name,parent_id&ledger_id=eq.'+lid)]);
    const catMap=new Map(categories.map(c=>[c.id,c]));
    const byPurchase=new Map();for(const item of items){if(!byPurchase.has(item.purchase_id))byPurchase.set(item.purchase_id,[]);byPurchase.get(item.purchase_id).push(item);}
    const mapped=ps.map(p=>({
      id:p.id,bookId:lid,date:new Date(p.purchased_at).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}),
      merchant:p.store_name||'購入先未設定',source:p.source,createdAt:p.created_at,updatedAt:p.created_at,
      reviewStatus:p.review_status,receiptTotal:p.receipt_total,receiptFingerprint:p.receipt_fingerprint,
      receiptImagePath:p.receipt_image_path||null,receiptImageUploadedAt:p.receipt_image_uploaded_at||null,
      receiptImageExpiresAt:p.receipt_image_expires_at||null,receiptOcrText:p.receipt_ocr_text||'',
      items:(byPurchase.get(p.id)||[]).map(i=>{
        const cat=catMap.get(i.category_id),parent=catMap.get(cat?.parent_id);
        return{id:i.id,name:i.name,canonical:i.normalized_name||i.name,amount:Number(i.line_total),qty:Number(i.quantity),
          size:i.package_amount===null?null:Number(i.package_amount),unit:i.package_unit||i.unit||'g',
          category:parent?.name||'その他',subcategory:cat?.name||'未分類',origin:i.origin||'',state:i.storage_type||'',allocations:Array.isArray(i.accounting_allocations)?i.accounting_allocations:[],mealAllocations:i.meal_allocations&&Object.keys(i.meal_allocations).length?i.meal_allocations:null};
      })
    }));
    if(!window.cloudMode)sbLocal=structuredClone(state);
    sbCategories=categories;sbLedger=lid;
    state={schemaVersion:1,books:[myPersonal],activeBook:lid,purchases:mapped,aliases:sbLocal?.aliases||{}};
    window.cloudMode=true;sbUi(true);refresh();
    if(window.learningOnCloudLoaded)await window.learningOnCloudLoaded();
    sbStatus('クラウド同期中：'+mapped.length+'件を表示しています。手入力の登録・編集・削除が同期されます。');
  }catch(e){sbStatus('読み込みに失敗：'+e.message);if(!window.cloudMode)sbUi(false);}
  finally{sbBusy=false;if(window.cloudMode)setTimeout(()=>sbPurgeExpiredReceiptImages().catch(console.warn),1500);}
}
async function sbPost(table,data,upsert=false){
  const pref=upsert?'resolution=merge-duplicates,return=representation':'return=representation';
  return sbApi('/rest/v1/'+table,{method:'POST',data,extraHeaders:{Prefer:pref}});
}
async function sbCategory(major,minor){
  async function ensure(name,parent){
    let found=sbCategories.find(x=>x.name===name&&(x.parent_id||null)===(parent||null));
    if(found)return found.id;
    const created=await sbPost('categories',[{name,parent_id:parent||null,ledger_id:sbLedger}]);
    found=created[0];sbCategories.push(found);return found.id;
  }
  const root=await ensure(major||'その他',null);
  return ensure(minor||'未分類',root);
}
// Private photo storage. Files are never copied to GitHub Pages or public Storage buckets.
function sbStoragePath(path){return String(path||'').split('/').map(encodeURIComponent).join('/');}
async function sbUploadReceiptImage(purchaseId,base64){
  if(!window.cloudMode||!sbSession?.access_token||!sbLedger)throw Error('写真保存にはログインが必要です');
  if(sbSession.expires_at&&Date.now()/1000>sbSession.expires_at-90)await sbRefresh();
  if(typeof base64!=='string'||base64.length>6_800_000)throw Error('画像容量が大きすぎます');
  const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
  if(bytes.byteLength>5*1024*1024)throw Error('5MB以下の写真にしてください');
  const path=sbSession.user.id+'/'+purchaseId+'-'+crypto.randomUUID()+'.jpg';
  const res=await fetch(SB_URL+'/storage/v1/object/receipt-images/'+sbStoragePath(path),{
    method:'POST',headers:{apikey:SB_PUBLISHABLE,Authorization:'Bearer '+sbSession.access_token,'Content-Type':'image/jpeg','x-upsert':'false'},
    body:new Blob([bytes],{type:'image/jpeg'})});
  if(!res.ok){const e=await res.json().catch(()=>({}));throw Error('レシート写真の保存に失敗：'+(e.message||e.error||res.status)+ '。Storage設定SQLを確認してください');}
  const savedAt=new Date();
  return {receiptImagePath:path,receiptImageUploadedAt:savedAt.toISOString(),receiptImageExpiresAt:new Date(savedAt.getTime()+30*86400000).toISOString()};
}
async function sbRemoveReceiptImage(path){
  if(!path)return;
  await sbApi('/storage/v1/object/receipt-images',{method:'DELETE',data:{prefixes:[path]}});
}
async function sbGetReceiptImageUrl(purchase){
  if(!purchase?.receiptImagePath)throw Error('保存済みのレシート写真はありません');
  if(purchase.receiptImageExpiresAt && Date.now()>=Date.parse(purchase.receiptImageExpiresAt))throw Error('写真の保存期限（30日）が過ぎています');
  if(purchase.receiptImageUploadedAt && Date.now()-Date.parse(purchase.receiptImageUploadedAt)>30*86400000)throw Error('写真の保存期限（30日）が過ぎています');
  const res=await sbApi('/storage/v1/object/sign/receipt-images/'+sbStoragePath(purchase.receiptImagePath),
    {method:'POST',data:{expiresIn:600}});
  const signed=res?.signedURL||res?.signedUrl||res?.signed_url;
  if(typeof signed!=='string'||!signed)throw Error('写真の閲覧URLを取得できません');
  if(/^https:\/\//i.test(signed))return signed;
  return SB_URL+(signed.startsWith('/storage/')?signed:'/storage/v1'+(signed.startsWith('/')?'':'/')+signed);
}
// Private authenticated photo download for 90-degree rotation and optional OCR rerun.
async function sbDownloadReceiptImage(purchase){
  if(!window.cloudMode||!sbSession?.access_token||!purchase?.receiptImagePath)throw Error('写真の読み込みにはログインが必要です');
  if(purchase.receiptImageExpiresAt&&Date.now()>=Date.parse(purchase.receiptImageExpiresAt))throw Error('写真は保存期限を過ぎています');
  if(sbSession.expires_at&&Date.now()/1000>sbSession.expires_at-90)await sbRefresh();
  const res=await fetch(SB_URL+'/storage/v1/object/authenticated/receipt-images/'+sbStoragePath(purchase.receiptImagePath),{
    headers:{apikey:SB_PUBLISHABLE,Authorization:'Bearer '+sbSession.access_token}
  });
  if(!res.ok)throw Error('写真の取得に失敗しました（HTTP '+res.status+'）。Storageのアクセス権を確認してください');
  return res.blob();
}
async function sbAttachReceiptImage(purchase,base64){
  if(!window.cloudMode||!sbSession)throw Error('写真の添付にはログインが必要です');
  const metadata=await sbUploadReceiptImage(purchase.id,base64);
  try{
    const result=await sbApi('/rest/v1/purchases?id=eq.'+encodeURIComponent(purchase.id)+'&ledger_id=eq.'+encodeURIComponent(sbLedger),
      {method:'PATCH',data:{receipt_image_path:metadata.receiptImagePath,
        receipt_image_uploaded_at:metadata.receiptImageUploadedAt,receipt_image_expires_at:metadata.receiptImageExpiresAt},
        extraHeaders:{Prefer:'return=representation'}});
    if(!Array.isArray(result)||result.length!==1)throw Error('購入の更新に失敗しました');
  }catch(e){await sbRemoveReceiptImage(metadata.receiptImagePath).catch(()=>{});throw e;}
  if(purchase.receiptImagePath)await sbRemoveReceiptImage(purchase.receiptImagePath).catch(e=>console.warn('Old image cleanup:',e));
  Object.assign(purchase,metadata);
  return metadata;
}
// Best-effort cleanup on app use. The optional scheduled Edge Function performs unattended cleanup.
let sbPhotoCleanupRunning=false;
async function sbPurgeExpiredReceiptImages(){
  if(sbPhotoCleanupRunning||!window.cloudMode||!sbSession)return;
  const expired=state.purchases.filter(p=>p.receiptImagePath&&(
    (p.receiptImageExpiresAt&&Date.now()>=Date.parse(p.receiptImageExpiresAt))||
    (p.receiptImageUploadedAt&&Date.now()-Date.parse(p.receiptImageUploadedAt)>=30*86400000))).slice(0,30);
  if(!expired.length)return;
  sbPhotoCleanupRunning=true;
  try{for(const p of expired){
    try{
      await sbRemoveReceiptImage(p.receiptImagePath);
      await sbApi('/rest/v1/purchases?id=eq.'+encodeURIComponent(p.id)+'&ledger_id=eq.'+encodeURIComponent(sbLedger),
        {method:'PATCH',data:{receipt_image_path:null,receipt_image_expires_at:null}});
      p.receiptImagePath=null;p.receiptImageExpiresAt=null;
    }catch(e){console.warn('Expired receipt image cleanup will retry',e);}
  }}finally{sbPhotoCleanupRunning=false;}
}
window.sbUploadReceiptImage=sbUploadReceiptImage;
window.sbRemoveReceiptImage=sbRemoveReceiptImage;
window.sbGetReceiptImageUrl=sbGetReceiptImageUrl;
window.sbDownloadReceiptImage=sbDownloadReceiptImage;
window.sbAttachReceiptImage=sbAttachReceiptImage;

async function sbInsert(p){
  await sbPost('purchases',[{id:p.id,ledger_id:sbLedger,created_by:sbSession.user.id,
    purchased_at:p.date+'T12:00:00+09:00',store_name:p.merchant,source:p.source||'manual',
    receipt_total:p.receiptTotal==null?null:Number(p.receiptTotal),
    receipt_fingerprint:p.receiptFingerprint||null,review_status:p.reviewStatus||'ok',
    receipt_image_path:p.receiptImagePath||null,receipt_image_uploaded_at:p.receiptImageUploadedAt||null,
    receipt_image_expires_at:p.receiptImageExpiresAt||null,receipt_ocr_text:p.receiptOcrText||null}]);
  try{
    const mapped=[];
    for(const i of p.items){mapped.push({id:i.id,purchase_id:p.id,ledger_id:sbLedger,name:i.name,
      normalized_name:i.canonical||i.name,quantity:Number(i.qty),unit:i.unit,
      package_amount:i.size&&Number(i.size)>0?Number(i.size):null,package_unit:i.unit,
      origin:i.origin||null,storage_type:i.state||null,line_total:Number(i.amount),
      unit_price:Number(i.amount)/Number(i.qty),category_id:await sbCategory(i.category,i.subcategory),accounting_allocations:i.allocations||[],meal_allocations:mealAmounts(i)});}
    await sbPost('purchase_items',mapped);
  }catch(e){
    // Compensating rollback for failed line-item saves; avoid an empty purchase.
    try{await sbApi('/rest/v1/purchases?id=eq.'+p.id+'&ledger_id=eq.'+sbLedger,{method:'DELETE'});}catch{}
    throw e;
  }
}
window.cloudSavePurchaseFromForm=async function(){
  if(sbBusy)return toast('同期処理中です。少し待ってください。');
  const rows=[...document.querySelectorAll('.item-row')];
  if(!rows.length)return toast('商品を追加してください。');
  let p;
  try{const items=rows.map(rowData);p={id:uid(),bookId:sbLedger,date:$('purchaseDate').value||today(),
    merchant:$('merchant').value.trim()||'購入先未設定',source:'manual',items};}catch(e){return toast(e.message);}
  sbBusy=true;toast('クラウドに登録しています…');
  try{await sbInsert(p);$('itemInputs').innerHTML='';addRow();$('merchant').value='';toast('クラウドに登録しました。');}
  catch(e){toast('登録失敗：'+e.message);sbBusy=false;return;}
  sbBusy=false;await sbLoad();
};
window.cloudDeletePurchase=async function(id){
  const oldPhoto=state.purchases.find(p=>p.id===id)?.receiptImagePath;
  if(sbBusy)return toast('同期処理中です。');sbBusy=true;
  try{
    if(oldPhoto)await sbRemoveReceiptImage(oldPhoto);
    await sbApi('/rest/v1/purchases?id=eq.'+encodeURIComponent(id)+'&ledger_id=eq.'+sbLedger,{method:'DELETE'});
    toast('クラウドから購入と保存写真を削除しました。');}catch(e){toast('削除失敗：'+e.message);sbBusy=false;return;}
  sbBusy=false;await sbLoad();
};
window.cloudEditItem=async function(pid,iid){
  if(sbBusy)return toast('同期処理中です。');
  const p=state.purchases.find(p=>p.id===pid),i=p?.items.find(x=>x.id===iid);
  if(!i)return;
  const name=prompt('商品名',i.name);if(name===null)return;
  const canonical=prompt('統一商品名',i.canonical);if(canonical===null)return;
  const amount=prompt('税込金額（円）',String(i.amount));if(amount===null)return;
  if(!name.trim()||!canonical.trim()||!Number.isFinite(Number(amount))||Number(amount)<0)return toast('入力が不正です。');
  sbBusy=true;
  try{
    await sbApi('/rest/v1/purchase_items?id=eq.'+encodeURIComponent(iid)+'&ledger_id=eq.'+sbLedger,
      {method:'PATCH',data:{name:name.trim(),normalized_name:canonical.trim(),line_total:Number(amount),unit_price:Number(amount)/Number(i.qty)}});
    toast('クラウドの明細を更新しました。');
  }catch(e){toast('編集失敗：'+e.message);sbBusy=false;return;}
  sbBusy=false;await sbLoad();
};
// Edit whole receipt/purchase with category, quantities and split lines.
// Writes each row with stable IDs; deletions are last to reduce accidental data loss.
window.cloudSaveEditedPurchase=async function(original,edited){
  if(sbBusy)throw Error('別の同期処理中です。少し待ってください。');
  if(!window.cloudMode||!sbSession?.access_token||!sbLedger)throw Error('再ログインしてください。');
  if(original.bookId!==sbLedger||edited.id!==original.id)throw Error('編集中の家計簿が違います。再読み込みしてください。');
  sbBusy=true;
  let saved=false;
  try{
    // Resolve categories before modifying purchase rows.
    const prepared=[];
    for(const i of edited.items){
      const cat=await sbCategory(i.category,i.subcategory);
      const values={purchase_id:edited.id,ledger_id:sbLedger,name:i.name,normalized_name:i.canonical,
        quantity:Number(i.qty),unit:i.unit,package_amount:i.size??null,package_unit:i.unit,
        origin:i.origin||null,storage_type:i.state||null,line_total:Number(i.amount),
        unit_price:Math.round(Number(i.amount)/Number(i.qty)*100)/100,category_id:cat,accounting_allocations:i.allocations||[],meal_allocations:mealAmounts(i)};
      prepared.push({id:i.id,values});
    }
    const priorIds=new Set(original.items.map(i=>i.id));
    const retained=new Set(edited.items.map(i=>i.id));
    // Insert first so no items are lost if another action fails.
    for(const row of prepared){if(!priorIds.has(row.id))await sbPost('purchase_items',[{id:row.id,...row.values}]);}
    for(const row of prepared){
      if(!priorIds.has(row.id))continue;
      const changed=await sbApi('/rest/v1/purchase_items?id=eq.'+encodeURIComponent(row.id)+
        '&purchase_id=eq.'+encodeURIComponent(edited.id)+'&ledger_id=eq.'+encodeURIComponent(sbLedger),
        {method:'PATCH',data:row.values,extraHeaders:{Prefer:'return=representation'}});
      if(!Array.isArray(changed)||changed.length!==1)throw Error('商品の更新権限または対象明細を確認してください。');
    }
    const changedPurchase=await sbApi('/rest/v1/purchases?id=eq.'+encodeURIComponent(edited.id)+
      '&ledger_id=eq.'+encodeURIComponent(sbLedger),{method:'PATCH',data:{
        purchased_at:edited.date+'T12:00:00+09:00',store_name:edited.merchant,
        receipt_total:edited.receiptTotal,review_status:edited.reviewStatus,
        receipt_ocr_text:edited.receiptOcrText||null},extraHeaders:{Prefer:'return=representation'}});
    if(!Array.isArray(changedPurchase)||changedPurchase.length!==1)throw Error('購入の更新権限を確認してください。');
    for(const old of original.items){
      if(retained.has(old.id))continue;
      await sbApi('/rest/v1/purchase_items?id=eq.'+encodeURIComponent(old.id)+
        '&purchase_id=eq.'+encodeURIComponent(edited.id)+'&ledger_id=eq.'+encodeURIComponent(sbLedger),{method:'DELETE'});
    }
    saved=true;
  }finally{
    sbBusy=false;
    // In case of partial network failure, reload from actual DB, not a local approximation.
    try{await sbLoad()}catch(e){console.error('Reload after edit failed',e);}
    if(!saved)console.warn('Partial edit may have been saved. Review this purchase.');
  }
};
async function sbImport(){
  if(sbBusy||!sbLedger)return;
  const old=sbLocal;
  const personalIds=new Set((old?.books||[]).filter(b=>b.kind==='personal').map(b=>b.id));
  const rows=(old?.purchases||[]).filter(p=>personalIds.has(p.bookId));
  if(!rows.length)return toast('端末内の個人用購入履歴はありません。');
  const existing=new Set(state.purchases.map(p=>p.id));
  const missing=rows.filter(p=>!existing.has(p.id));
  if(!missing.length)return toast('端末内の購入履歴はすでに登録済みです。');
  if(!confirm('端末内の個人用履歴 '+missing.length+' 件をクラウドに追加します。作業前にJSONバックアップの保存をおすすめします。続けますか？'))return;
  sbBusy=true;let success=0;
  try{for(const p of missing){await sbInsert(p);success++;}toast(success+'件を取り込みました。');}
  catch(e){toast(success+'件取り込み後に停止：'+e.message);}
  sbBusy=false;await sbLoad();
}
function sbLogout(){
  if(!confirm('クラウドからログアウトしますか？'))return;
  sbSessionStore(null);sbLedger=null;window.cloudMode=false;
  state=sbLocal||structuredClone(DEFAULT);sbLocal=null;sbCategories=[];sbUi(false);refresh();window.learningOnSignOut?.();
  sbStatus('ログアウトしました。端末内データを表示しています。');
}
function sbInit(){
  $('cloudLogin').onclick=()=>sbAuth(false);$('cloudSignup').onclick=()=>sbAuth(true);
  $('cloudSignout').onclick=sbLogout;$('cloudRefresh').onclick=sbLoad;$('cloudImport').onclick=sbImport;
  sbUi(false);
  try{const s=JSON.parse(localStorage.getItem(SB_SESSION_KEY));if(s?.access_token&&s?.refresh_token){sbSession=s;sbLoad();}}catch{}
}
sbInit();
