'use strict';
// OCR + photo + conservative monetary reconciliation v1.2. Browser only gets a public Supabase key and the user's JWT.
let receiptRunning=false;
const receiptStates=new WeakMap();
const receiptEl=id=>document.getElementById(id);
function receiptStatus(s){receiptEl('receiptStatus').textContent=s;}
function queueSummary(){
  const root=receiptEl('imageQueue');
  if(!pendingImages.length){root.textContent='画像は未選択です。';return;}
  root.innerHTML='';
  for(const [idx,file] of pendingImages.entries()){
    const div=document.createElement('div');div.className='line';
    const a=document.createElement('span'),b=document.createElement('small');
    a.textContent=`${idx+1}. ${file.name||'撮影したレシート'}`;
    b.textContent=receiptStates.get(file)||'待機中';
    div.append(a,b);root.append(div);
  }
}
window.receiptQueueChanged=()=>{queueSummary();receiptStatus(pendingImages.length+'枚選択しました。順番に処理します。');};
async function extractImage(file){
  if(!file||!file.type.startsWith('image/'))throw Error('写真の画像ファイルを指定してください');
  const url=URL.createObjectURL(file),img=new Image();
  try{
    img.src=url;await img.decode();
    const maxPixels=3400;
    let scale=Math.min(1,maxPixels/Math.max(img.naturalHeight,img.naturalWidth));
    let quality=.91;
    for(let attempt=0;attempt<6;attempt++){
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));
      canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
      const ctx=canvas.getContext('2d',{alpha:false});
      if(!ctx)throw Error('画像を開けませんでした');
      ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      const data=canvas.toDataURL('image/jpeg',quality).split(',')[1];
      if(data&&data.length<=6_400_000)return{imageBase64:data,mimeType:'image/jpeg',width:canvas.width,height:canvas.height};
      quality=Math.max(.72,quality-.045);scale*=.86;
    }
    throw Error('写真が大きすぎます。画質を下げてからお試しください');
  }finally{URL.revokeObjectURL(url);}
}
async function receiptFingerprint(text){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(text).normalize('NFKC').replace(/[\s\u3000]+/g,'').toLowerCase()));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
async function scanOne(file){
  const image=await extractImage(file);
  let result={text:'',layoutLines:[]};
  try{result=await sbApi('/functions/v1/receipt-ocr',{method:'POST',data:image});}
  catch(e){
    // Only turn genuinely unreadable photos into editable drafts; connectivity / API errors should be retried.
    if(!/文字を検出できません|文字を検出できなかった/i.test(e.message))throw e;
  }
  const parsed=ocrExtractReceipt(result.text||'',result.layoutLines||[]);
  const fingerprint=await receiptFingerprint(parsed.items.length?result.text||image.imageBase64:image.imageBase64);
  if(state.purchases.some(p=>p.receiptFingerprint===fingerprint))return{status:'duplicate',parsed};
  const items=parsed.items.map(({name,amount})=>{
    const [category,subcategory]=guessCategory(name);
    const base={id:uid(),name,canonical:normalize(name),amount,qty:1,size:null,unit:'個',category,subcategory,origin:'',state:''};
    return window.learningApplyOCRItem?.(base)||base;
  });
  // A tax-only OCR result must NEVER fabricate a tax item or a purchase amount.
  if(!items.length){items.push({id:uid(),name:'未読み取り：レシート写真を見て入力',canonical:'未読み取り',amount:0,qty:1,size:null,unit:'個',category:'その他',subcategory:'未分類',origin:'',state:''});}
  const warnings=[...parsed.warnings];
  if(items.some(i=>i.smartPrediction?.level==='low'||i.category==='その他'))warnings.push('商品分類・内容の確認が必要です');
  if(parsed.reconciliation.status!=='match'&&!warnings.length)warnings.push('レシート合計・消費税の照合が必要です');
  const p={id:uid(),bookId:sbLedger,date:parsed.date||today(),merchant:parsed.merchant,
    source:'receipt',items,receiptTotal:parsed.total,receiptFingerprint:fingerprint,
    reviewStatus:warnings.length?'needs_review':'ok',receiptOcrText:ocrRedactPrivateText(String(result.text||'').slice(0,30000))};
  // Persist the original compressed photo FIRST. A storage error cannot silently lose the evidence.
  const meta=await window.sbUploadReceiptImage(p.id,image.imageBase64);
  Object.assign(p,meta);
  try{await sbInsert(p);}catch(e){await window.sbRemoveReceiptImage(meta.receiptImagePath).catch(()=>{});
    if(/duplicate key|23505|unique constraint/i.test(e.message))return{status:'duplicate',parsed};
    throw e;
  }
  return{status:warnings.length?'review':'ok',parsed:{...parsed,warnings},purchaseId:p.id};
}
async function receiptScanAll(){
  if(receiptRunning||sbBusy)return receiptStatus('別の処理が進行しています。');
  if(!window.cloudMode||!sbSession?.access_token)return receiptStatus('先に「設定」でログインしてください');
  if(!pendingImages.length)return receiptStatus('レシート画像を選択してください');
  receiptRunning=true;sbBusy=true;receiptEl('ocrStart').disabled=true;receiptEl('ocrClear').disabled=true;
  let success=0,review=0,failed=0,duplicate=0,lastReview=null;
  try{
    for(const file of pendingImages){
      const old=receiptStates.get(file)||'';
      if(/^(登録済|要確認|重複)/.test(old))continue;
      receiptStates.set(file,'OCR読み取り中…');queueSummary();
      try{
        const out=await scanOne(file);
        if(out.status==='duplicate'){duplicate++;receiptStates.set(file,'重複のため登録しませんでした');}
        else if(out.status==='review'){review++;lastReview=out.purchaseId;receiptStates.set(file,`要確認として写真付き保存：${out.parsed.items.length}商品候補 ／ 明細 ${yen(out.parsed.lineSum)} ／ レシート ${out.parsed.total==null?'不明':yen(out.parsed.total)}`);}
        else{success++;receiptStates.set(file,`照合OK・写真付き登録：${out.parsed.items.length}商品 ／ ${yen(out.parsed.lineSum)}`);}
      }catch(e){failed++;receiptStates.set(file,'失敗：'+e.message);}
      queueSummary();receiptStatus(`登録${success}件・要確認${review}件・重複${duplicate}件・失敗${failed}件`);
    }
  }finally{
    receiptRunning=false;sbBusy=false;receiptEl('ocrStart').disabled=false;receiptEl('ocrClear').disabled=false;
    if(success+review)await sbLoad();
    receiptStatus(`完了：登録${success}件、要確認${review}件、重複${duplicate}件、失敗${failed}件。履歴の「購入全体を編集」から写真を見て修正できます。`);
    if(lastReview){const p=state.purchases.find(x=>x.id===lastReview);if(p)window.openPurchaseEditor?.(p.id);}
  }
}
function receiptAuditHTML(parsed,purchase){
  const a=parsed.reconciliation;
  const money=value=>value==null?'不明':yen(value);
  const status=a.status==='match'?'金額上は一致':'要確認';
  const description={inclusive:'税込表記として処理（税の二重加算なし）',exclusive:'税抜表記として処理（レシート上の税額を配分）','exclusive-estimated':'税抜推定（レシート合計が不明）',unreconciled:'商品明細・税額・値引きの差額を確認してください',unknown:'税込・税抜を確定できません'}[a.mode]||'確認が必要です';
  const savedSum=purchase?.items?.reduce((sum,item)=>sum+Number(item.amount||0),0);
  const changed=savedSum!=null&&Math.abs(savedSum-a.itemSum)>.01;
  const details=a.explanations.map(line=>`<li>${esc(line)}</li>`).join('');
  const excluded=parsed.ignoredLines.slice(0,16).map(line=>`<li>${esc(ocrRedactPrivateText(line))}</li>`).join('');
  return `<div class="audit-status ${a.status==='match'?'audit-ok':'audit-review'}">${status}</div>
    <div class="audit-figures">
      <div><small>OCR商品候補</small><strong>${parsed.items.length}件</strong></div>
      <div><small>読取商品金額（税抜の可能性）</small><strong>${money(a.rawSum)}</strong></div>
      <div><small>印字された小計</small><strong>${money(a.subtotal)}</strong></div>
      <div><small>印字された消費税</small><strong>${money(a.observedTax)}</strong></div>
      <div><small>加算した消費税</small><strong>${money(a.allocatedTax)}</strong></div>
      <div><small>税込明細の合計</small><strong>${money(a.itemSum)}</strong></div>
      <div><small>レシート印字の合計</small><strong>${money(a.printedTotal)}</strong></div>
      <div><small>税込明細と印字合計の差</small><strong>${a.printedTotal==null?'不明':money(a.printedTotal-a.itemSum)}</strong></div>
    </div><p class="audit-note">${esc(description)}。${a.observedTax!=null?'印字された税額 '+money(a.observedTax)+'。':''}</p>
    ${changed?`<p class="audit-saved-warning">現在の保存済み明細 ${money(savedSum)} と、新解析 ${money(a.itemSum)} が異なります。**再作成**ボタンで候補を確認後に取り込めます（保存前は履歴に影響しません）。</p>`.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>'):''}
    ${details?`<ul class="audit-reasons">${details}</ul>`:''}
    ${parsed.items.length?`<details class="audit-ignored"><summary>商品ごとの税抜金額・加算税額・税込金額を確認</summary><div class="audit-table-wrap"><table class="audit-table"><thead><tr><th>商品</th><th>読取額</th><th>加算税</th><th>税込</th></tr></thead><tbody>${parsed.items.map(item=>`<tr><td>${esc(item.name)}</td><td>${money(item.rawAmount)}</td><td>${money(item.taxAdded||0)}</td><td><strong>${money(item.amount)}</strong></td></tr>`).join('')}</tbody></table></div></details>`:''}
    ${excluded?`<details class="audit-ignored"><summary>商品として登録しなかった行を確認（${parsed.ignoredLines.length}行）</summary><ul>${excluded}</ul></details>`:''}`;
}
function receiptShowAuditInEditor(p){
  const panel=receiptEl('editReceiptAudit');if(!panel)return;
  if(!p?.receiptOcrText){panel.innerHTML='<h3>レシート金額の照合</h3><p class="muted">この履歴にOCR原文がありません。レシート写真と明細合計を比較してください。</p>';return;}
  try{panel.innerHTML='<h3>レシート金額の照合</h3>'+receiptAuditHTML(ocrExtractReceipt(p.receiptOcrText),p);}
  catch(e){panel.innerHTML='<h3>レシート金額の照合</h3><p class="muted">再解析できませんでした。写真で内容を確認してください。</p>';console.error(e);}
}
let receiptPhotoSignedUrl='',receiptPhotoZoom=1,receiptPhotoOpenSeq=0;
function receiptClearPhotoInEditor(){
  receiptPhotoOpenSeq++;
  receiptPhotoSignedUrl='';receiptPhotoZoom=1;
  receiptEl('editReceiptReference').classList.remove('has-photo');
  const img=receiptEl('editReceiptImage');img.hidden=true;img.removeAttribute('src');
  receiptEl('editReceiptPhotoMessage').hidden=false;
  receiptEl('editReceiptPhotoMessage').textContent='保存済み写真はありません。必要なら下から追加できます。';
  receiptEl('editPhotoZoomValue').textContent='100%';
  receiptEl('editPhotoAttach').value='';
}
window.receiptClearPhotoInEditor=receiptClearPhotoInEditor;
async function receiptShowPhotoInEditor(p){
  receiptClearPhotoInEditor();
  const seq=receiptPhotoOpenSeq;
  receiptEl('editOcrText').textContent=p.receiptOcrText?ocrRedactPrivateText(p.receiptOcrText):'この購入にはOCR原文が保存されていません。';
  receiptShowAuditInEditor(p);
  receiptEl('editPhotoStatus').textContent='原本写真はログインしている本人のみ閲覧できます。保存期間は約30日です。';
  if(!p.receiptImagePath)return;
  receiptEl('editReceiptPhotoMessage').textContent='非公開の写真を読み込んでいます…';
  try{
    const url=await window.sbGetReceiptImageUrl(p);
    if(seq!==receiptPhotoOpenSeq)return;
    receiptPhotoSignedUrl=url;
    const img=receiptEl('editReceiptImage');img.onload=()=>{if(seq===receiptPhotoOpenSeq){img.hidden=false;receiptEl('editReceiptPhotoMessage').hidden=true;receiptEl('editReceiptReference').classList.add('has-photo');}};
    img.onerror=()=>{if(seq===receiptPhotoOpenSeq){img.hidden=true;receiptEl('editReceiptPhotoMessage').hidden=false;receiptEl('editReceiptPhotoMessage').textContent='写真を開けませんでした。ログインと保存期限を確認してください。';}};
    img.src=url;
    img.style.width='100%';
  }catch(e){if(seq===receiptPhotoOpenSeq)receiptEl('editReceiptPhotoMessage').textContent=e.message;}
}
window.receiptShowPhotoInEditor=receiptShowPhotoInEditor;
async function receiptAttachFromEditor(file){
  if(!file)return;
  if(!window.cloudMode)return receiptEl('editPhotoStatus').textContent='写真を長期保存するにはクラウドへのログインが必要です';
  if(!currentEditPurchase)return;
  const previous=currentEditPurchase;
  receiptEl('editPhotoStatus').textContent='写真を安全な領域に保存しています…';
  try{
    const image=await extractImage(file);
    const meta=await window.sbAttachReceiptImage(previous,image.imageBase64);
    Object.assign(currentEditPurchase,meta);
    const target=state.purchases.find(x=>x.id===previous.id);
    if(target)Object.assign(target,meta);
    receiptEl('editPhotoStatus').textContent='写真を保存しました。約30日間閲覧できます。';
    await receiptShowPhotoInEditor(currentEditPurchase);
  }catch(e){receiptEl('editPhotoStatus').textContent='保存失敗：'+e.message;}
}
function receiptInit(){
  receiptEl('ocrStart').onclick=()=>receiptScanAll().catch(e=>receiptStatus('エラー：'+e.message));
  receiptEl('ocrClear').onclick=()=>{if(receiptRunning)return;pendingImages=[];receiptEl('camera').value='';receiptEl('images').value='';queueSummary();receiptStatus('選択を解除しました');};
  receiptEl('editPhotoAttach').onchange=e=>receiptAttachFromEditor(e.target.files?.[0]);
  const image=receiptEl('editReceiptImage');
  const zoom=n=>{receiptPhotoZoom=Math.max(.5,Math.min(3,receiptPhotoZoom+n));image.style.width=(receiptPhotoZoom*100)+'%';receiptEl('editPhotoZoomValue').textContent=Math.round(receiptPhotoZoom*100)+'%';};
  receiptEl('editPhotoZoomOut').onclick=()=>zoom(-.25);
  receiptEl('editPhotoZoomIn').onclick=()=>zoom(.25);
  receiptEl('editPhotoNewTab').onclick=()=>{if(receiptPhotoSignedUrl)window.open(receiptPhotoSignedUrl,'_blank','noopener,noreferrer');else receiptEl('editPhotoStatus').textContent='表示できる写真がありません';};
  receiptEl('editOcrRetryParse').onclick=()=>{
    if(!currentEditPurchase?.receiptOcrText)return receiptEl('editPhotoStatus').textContent='この購入には保存されたOCR原文がありません';
    const parsed=ocrExtractReceipt(currentEditPurchase.receiptOcrText);
    if(!parsed.items.length)return receiptEl('editPhotoStatus').textContent='原文から商品を特定できませんでした。写真を見ながら手動で明細を入力してください';
    const currentRows=editGet('editItems').children.length;
    const originalItems=currentEditPurchase.items||[];
    const used=new Set();
    const prepared=parsed.items.map(candidate=>{
      const{name,amount}=candidate;
      const[category,subcategory]=guessCategory(name);
      const draft={id:uid(),name,canonical:normalize(name),amount,qty:1,size:null,unit:'個',category,subcategory,origin:'',state:'',allocations:[{month:String(currentEditPurchase.date||today()).slice(0,7),amount,quantity:null}]};
      const learned=window.learningApplyOCRItem?.(draft)||draft;
      const signature=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s\u3000\-・_.,]/g,'');
      const match=originalItems.find(i=>!used.has(i.id)&&[i.name,i.canonical].some(v=>signature(v)===signature(name)||signature(v)===signature(learned.canonical)));
      if(!match)return{item:learned,preserved:false};
      used.add(match.id);
      let plans=Array.isArray(match.allocations)&&match.allocations.length?structuredClone(match.allocations):draft.allocations;
      const previousSum=plans.reduce((v,a)=>v+Math.max(0,Number(a.amount)||0),0);
      if(previousSum>0){
        const cents=Math.round(amount*100),raw=plans.map(a=>cents*Math.max(0,Number(a.amount)||0)/previousSum),allocated=raw.map(Math.floor);
        let remainder=cents-allocated.reduce((v,x)=>v+x,0);
        const indices=raw.map((n,i)=>({i,f:n-allocated[i]})).sort((a,b)=>b.f-a.f||a.i-b.i);
        for(let k=0;k<remainder;k++)allocated[indices[k%indices.length].i]++;
        plans=plans.map((a,k)=>({...a,amount:allocated[k]/100}));
      }else{plans=[{month:draft.allocations[0].month,amount,quantity:null}];}
      return{item:{...match,...learned,id:match.id,name:match.name,canonical:match.canonical,amount,qty:match.qty,size:match.size,unit:match.unit,origin:match.origin,state:match.state,allocations:plans},preserved:true};
    });
    const preserved=prepared.filter(x=>x.preserved).length;
    const text=`再解析で ${parsed.items.length}件の候補を見つけました（税・小計・カード番号は除外）。現在の編集欄 ${currentRows}件と入れ替えます。\n同じ商品と判定できた ${preserved}件は、元の計上月・配分比率を保持します。その他の商品は購入月に初期化されます。\n\n保存するまでは購入履歴には反映されません。続けますか？`;
    if(!confirm(text))return;
    const rows=editGet('editItems');rows.innerHTML='';
    prepared.forEach(({item})=>rows.append(editNewRow(item)));
    if(parsed.total!=null)editGet('editReceiptTotal').value=parsed.total;
    editGet('editReview').value=parsed.reconciliation.status==='match'?'ok':'needs_review';
    editTotals();
    receiptEl('editPhotoStatus').textContent=`明細を ${parsed.items.length}件に入れ替えました（${preserved}件は既存の月別配分を保持）。写真で品名・税率・税込金額と月別配分を確認してから「変更を保存」を押してください。`;
    receiptShowAuditInEditor({...currentEditPurchase,items:parsed.items,receiptOcrText:currentEditPurchase.receiptOcrText});
  };
  queueSummary();
}
receiptInit();
