'use strict';
// OCR + photo attachment v1.1. Browser only gets a public Supabase key and the user's JWT.
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
  const p={id:uid(),bookId:sbLedger,date:parsed.date||today(),merchant:parsed.merchant,
    source:'receipt',items,receiptTotal:parsed.total,receiptFingerprint:fingerprint,
    reviewStatus:warnings.length?'needs_review':'ok',receiptOcrText:String(result.text||'').slice(0,30000)};
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
        else if(out.status==='review'){review++;lastReview=out.purchaseId;receiptStates.set(file,`要確認として写真付きで保存（${out.parsed.items.length}商品候補）`);}
        else{success++;receiptStates.set(file,`写真付きで登録済（${out.parsed.items.length}商品）`);}
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
  receiptEl('editOcrText').textContent=p.receiptOcrText||'この購入にはOCR原文が保存されていません。';
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
    if(!parsed.items.length)return receiptEl('editPhotoStatus').textContent='原文から商品を特定できませんでした。写真を見て明細を追加してください';
    if(!confirm('OCR原文から見つかった '+parsed.items.length+' 行の候補を編集画面に追加します。既存の明細は残します。追加しますか？'))return;
    const rows=editGet('editItems');
    for(const {name,amount} of parsed.items){const [category,subcategory]=guessCategory(name);const proposed={id:uid(),name,canonical:normalize(name),amount,qty:1,size:null,unit:'個',category,subcategory,origin:'',state:''};rows.append(editNewRow(window.learningApplyOCRItem?.(proposed)||proposed));}
    editTotals();receiptEl('editPhotoStatus').textContent='明細候補を追加しました。重複している行や誤認識した行は削除・修正し、「変更を保存」してください';
  };
  queueSummary();
}
receiptInit();
