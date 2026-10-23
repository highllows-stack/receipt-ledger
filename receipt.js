'use strict';
// OCR + photo + conservative monetary reconciliation v1.3. Browser only gets a public Supabase key and the user's JWT.
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
  const items=parsed.items.map(({name,amount,qty,unit})=>{
    const [category,subcategory]=guessCategory(name);
    const base={id:uid(),name,canonical:normalize(name),amount,qty:qty||1,size:null,unit:unit||'個',category,subcategory,origin:'',state:''};
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
      <div><small>OCR商品明細</small><strong>${parsed.items.length}行</strong></div>
      <div><small>印字点数／解析点数</small><strong>${a.printedCount??'不明'}／${a.parsedCount}点</strong></div>
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
    ${parsed.items.length?`<details class="audit-ignored"><summary>商品ごとの税抜金額・加算税額・税込金額を確認</summary><div class="audit-table-wrap"><table class="audit-table"><thead><tr><th>商品</th><th>数量</th><th>読取額</th><th>加算税</th><th>税込</th></tr></thead><tbody>${parsed.items.map(item=>`<tr><td>${esc(item.name)}</td><td>${item.qty||1}</td><td>${money(item.rawAmount)}</td><td>${money(item.taxAdded||0)}</td><td><strong>${money(item.amount)}</strong></td></tr>`).join('')}</tbody></table></div></details>`:''}
    ${excluded?`<details class="audit-ignored"><summary>商品として登録しなかった行を確認（${parsed.ignoredLines.length}行）</summary><ul>${excluded}</ul></details>`:''}`;
}
function receiptShowAuditInEditor(p){
  const panel=receiptEl('editReceiptAudit');if(!panel)return;
  if(!p?.receiptOcrText){panel.innerHTML='<h3>レシート金額の照合</h3><p class="muted">この履歴にOCR原文がありません。レシート写真と明細合計を比較してください。</p>';return;}
  try{panel.innerHTML='<h3>レシート金額の照合</h3>'+receiptAuditHTML(ocrExtractReceipt(p.receiptOcrText),p);}
  catch(e){panel.innerHTML='<h3>レシート金額の照合</h3><p class="muted">再解析できませんでした。写真で内容を確認してください。</p>';console.error(e);}
}
// One-time, explicitly confirmed rescue of the particular receipt supplied as a photo
// by the user. This is not a replacement for general OCR and is NEVER applied silently.
function receiptIsUserVerifiedMaruetsu(p){
  if(!p||p.date!=='2026-10-23'||!/maruetsu|マルエツ/i.test(p.merchant||''))return false;
  const total=Number(p.receiptTotal);
  return total===14422&&p.items?.length>=10&&p.items?.some(i=>/(?:WAON|11点|レジ\s*No|レジ番号)/i.test(i.name));
}
function receiptApplyVerifiedMaruetsuRepair(){
  const p=currentEditPurchase;
  if(!receiptIsUserVerifiedMaruetsu(p))return;
  const content=[
    ['333 かぼちゃ',316,1,'食材','野菜'],
    ['521 TVBP 木綿豆腐',108,1,'食材','豆製品'],
    ['507 BP ブルーベリー',148,1,'食材','果物'],
    ['147 ドリンクゼリー',108,1,'食品・飲料','その他'],
    ['147 エナジー180M',108,1,'食品・飲料','飲料'],
    ['147 エナジー180R',108,1,'食品・飲料','飲料'],
    ['147 ドリンクゼリー',108,1,'食品・飲料','その他'],
    ['625 キャベツガリバタ',447,3,'食材','野菜'],
    ['625 にんにく炒め',149,1,'食品・飲料','惣菜・弁当']
  ];
  const rawTotal=content.reduce((sum,row)=>sum+row[1],0);
  if(rawTotal!==1600)throw Error('確認済みの小計が一致しません');
  const taxShares=ocrTaxShares(content.map(row=>row[1]*8),128);
  const entries=content.map((row,i)=>({name:row[0],raw:row[1],tax:taxShares[i],total:row[1]+taxShares[i],qty:row[2],category:row[3],subcategory:row[4]}));
  const gross=entries.reduce((sum,x)=>sum+x.total,0),points=entries.reduce((sum,x)=>sum+x.qty,0);
  if(gross!==1728||points!==11||entries.length!==9)throw Error('照合結果が一致しません');
  const preview=entries.map(x=>x.name+' ×'+x.qty+'　税込'+x.total+'円').join('\n');
  const message='今回送っていただいた写真と照合した商品9行／11点を編集欄へ読み込みます。\n'
    +'税抜小計1,600円＋印字消費税128円＝税込1,728円\n\n'+preview
    +'\n\n※ 税額はレシートの8％税額128円を各行に按分しています。'+
    '\n※ 現在編集中の明細と月別配分は置き換わります。購入履歴には「変更を保存」を押すまで反映されません。\n続けますか？';
  if(!confirm(message))return;
  const month='2026-10';
  const wrap=editGet('editItems');wrap.innerHTML='';
  for(const x of entries){
    const name=x.name.replace(/^\d{3}\s+/,'');
    const item={id:uid(),name,canonical:normalize(name),amount:x.total,qty:x.qty,size:null,unit:'個',
      category:x.category,subcategory:x.subcategory,origin:'',state:'',allocations:[{month,amount:x.total,quantity:null}]};
    wrap.append(editNewRow(item));
  }
  editGet('editReceiptTotal').value='1728';
  editGet('editReview').value='needs_review';
  editTotals();
  receiptEl('editReceiptAudit').innerHTML='<h3>写真で照合した明細候補（未保存）</h3>'+
    '<div class="audit-status audit-ok">商品9行・数量11点・税抜1,600円＋税128円＝税込1,728円</div>'+
    '<p class="audit-note">上の写真と見比べた修正候補を編集欄に表示しています。旧OCRの誤認識原文は証拠として残します。'+
    '108円の商品でも税込116円または117円になるのは、税額128円を行ごとに端数調整しているためです。</p>';
  receiptEl('editPhotoStatus').textContent='今回のレシートの正しい明細候補を編集欄へセットしました。商品と分類を確認して、画面下の「変更を保存」を押してください。';
  receiptEl('editReceiptRepairExample').hidden=true;
}
function receiptToggleVerifiedRepair(p){
  const b=receiptEl('editReceiptRepairExample');if(b)b.hidden=!receiptIsUserVerifiedMaruetsu(p);
}
let receiptPhotoSignedUrl='',receiptPhotoZoom=1,receiptPhotoOpenSeq=0;
let receiptPhotoOriginalBlob=null,receiptPhotoRotation=0,receiptPhotoRotatedBase64=null,receiptPhotoRotatedUrl='';
let receiptOCRFromRescan=null,receiptPhotoBusy=false;
function receiptRevokePreview(){if(receiptPhotoRotatedUrl){URL.revokeObjectURL(receiptPhotoRotatedUrl);receiptPhotoRotatedUrl='';}}
function receiptUpdateRotationButton(){
  receiptEl('editPhotoSaveRotation').disabled=!receiptPhotoRotation||receiptPhotoBusy||!currentEditPurchase?.receiptImagePath;
}
function receiptApplyVisualRotation(){
  const img=receiptEl('editReceiptImage'),area=receiptEl('editReceiptPhotoArea'),frame=receiptEl('editReceiptImageFrame');
  if(!img||!frame||!area||!img.naturalWidth||!img.naturalHeight||img.hidden)return;
  const sourceW=img.naturalWidth,sourceH=img.naturalHeight;
  const sideways=receiptPhotoRotation===90||receiptPhotoRotation===270;
  const available=Math.max(150,area.clientWidth-20),zoom=Math.max(.5,Math.min(3,receiptPhotoZoom));
  const fittedScale=sideways?available/sourceH:available/sourceW;
  const scale=fittedScale*zoom;
  const imageW=Math.max(1,sourceW*scale),imageH=Math.max(1,sourceH*scale);
  const outputW=sideways?imageH:imageW,outputH=sideways?imageW:imageH;
  frame.style.width=Math.ceil(outputW)+'px';frame.style.height=Math.ceil(outputH)+'px';
  img.style.width=imageW+'px';img.style.transform='translate(-50%,-50%) rotate('+receiptPhotoRotation+'deg)';
  receiptEl('editPhotoZoomValue').textContent=Math.round(zoom*100)+'%';
}

async function receiptGetOriginalBlob(){
  if(!receiptPhotoOriginalBlob){
    if(!currentEditPurchase?.receiptImagePath)throw Error('保存済みレシート写真がありません。');
    try{receiptPhotoOriginalBlob=await window.sbDownloadReceiptImage(currentEditPurchase);}
    catch(primary){
      // Private signed image is already visible; use it if authenticated download is rejected.
      if(!receiptPhotoSignedUrl)throw primary;
      const response=await fetch(receiptPhotoSignedUrl);
      if(!response.ok)throw primary;
      receiptPhotoOriginalBlob=await response.blob();
    }
  }
  return receiptPhotoOriginalBlob;
}
// Produce actual rotated JPEG pixels, not a CSS transform. Thus rotation survives
// a new device, signed URL, page reload and the image viewer.
async function receiptRotatedJPEG(original,degrees){
  const url=URL.createObjectURL(original);const src=new Image();
  try{src.src=url;await src.decode();}
  finally{URL.revokeObjectURL(url);}
  const sourceWidth=src.naturalWidth,sourceHeight=src.naturalHeight;
  let scale=Math.min(1,3400/Math.max(sourceWidth,sourceHeight)),quality=.91;
  for(let attempt=0;attempt<7;attempt++){
    const swapped=degrees%180!==0;
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round((swapped?sourceHeight:sourceWidth)*scale));
    canvas.height=Math.max(1,Math.round((swapped?sourceWidth:sourceHeight)*scale));
    const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw Error('画像を回転できませんでした');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.scale(scale,scale);
    if(degrees===90){ctx.translate(sourceHeight,0);ctx.rotate(Math.PI/2)}
    if(degrees===180){ctx.translate(sourceWidth,sourceHeight);ctx.rotate(Math.PI)}
    if(degrees===270){ctx.translate(0,sourceWidth);ctx.rotate(-Math.PI/2)}
    ctx.drawImage(src,0,0);
    const data=canvas.toDataURL('image/jpeg',quality).split(',')[1];
    if(data&&data.length<=6_400_000){
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
      if(!blob)throw Error('回転した写真を作れませんでした');
      return{base64:data,blob};
    }
    scale*=.84;quality=Math.max(.72,quality-.04);
  }
  throw Error('回転後の画像サイズが大きすぎます。画像を小さくしてから登録してください');
}
function receiptRotatePhoto(degreeDelta){
  if(receiptPhotoBusy)return;
  const img=receiptEl('editReceiptImage');
  if(!currentEditPurchase?.receiptImagePath||!img?.src||img.hidden){receiptEl('editPhotoStatus').textContent='先にレシート写真の読み込みが完了するまで待ってください。';return;}
  // Rotate locally FIRST. Do not wait for a Supabase download to show the change.
  receiptPhotoRotation=(receiptPhotoRotation+degreeDelta+360)%360;
  receiptApplyVisualRotation();receiptUpdateRotationButton();
  receiptEl('editPhotoStatus').textContent=receiptPhotoRotation===0?'プレビューを元の向きに戻しました。':
    '写真を '+receiptPhotoRotation+'° 回転しました（プレビュー）。別の端末にも反映するには「回転をクラウドに保存」を押してください。';
}
async function receiptSaveRotation(){
  if(receiptPhotoBusy||!receiptPhotoRotation||!currentEditPurchase)return;
  if(!confirm('この向きで写真をクラウドに保存しますか？ 新しい写真の有効期限は保存日から約30日です。'))return;
  receiptPhotoBusy=true;receiptUpdateRotationButton();
  try{
    receiptEl('editPhotoStatus').textContent='回転した写真を保存するため、画像データを取得しています…';
    const original=await receiptGetOriginalBlob();
    const converted=await receiptRotatedJPEG(original,receiptPhotoRotation);
    receiptEl('editPhotoStatus').textContent='回転した画像をクラウドに保存しています…';
    const meta=await window.sbAttachReceiptImage(currentEditPurchase,converted.base64);
    Object.assign(currentEditPurchase,meta);
    const stored=state.purchases.find(x=>x.id===currentEditPurchase.id);
    if(stored)Object.assign(stored,meta);
    await receiptShowPhotoInEditor(currentEditPurchase);
    receiptEl('editPhotoStatus').textContent='写真の回転をクラウドに保存しました。';
  }catch(e){receiptEl('editPhotoStatus').textContent='回転の保存に失敗：'+e.message+'。画面上の回転だけなら通信なしで使えます。';}
  finally{receiptPhotoBusy=false;receiptUpdateRotationButton();}
}
async function receiptRerunOCRFromPhoto(){
  if(receiptPhotoBusy||!currentEditPurchase?.receiptImagePath)return;
  if(!window.cloudMode)return receiptEl('editPhotoStatus').textContent='再OCRにはクラウドへのログインが必要です';
  if(!confirm('保存写真をGoogle Cloud Visionで再読み取りします。追加のOCRリクエスト1回分が発生し、無料枠・トライアルを超えると料金が発生する場合があります。実行しますか？'))return;
  receiptPhotoBusy=true;receiptUpdateRotationButton();
  const seq=receiptPhotoOpenSeq;
  try{
    receiptEl('editPhotoStatus').textContent='保存写真を再OCRしています…';
    let image;
    if(receiptPhotoRotation){const blob=await receiptGetOriginalBlob();const adjusted=await receiptRotatedJPEG(blob,receiptPhotoRotation);image={imageBase64:adjusted.base64,mimeType:'image/jpeg'};}
    else{const blob=await receiptGetOriginalBlob();image=await extractImage(new File([blob],'receipt.jpg',{type:blob.type||'image/jpeg'}));}
    const result=await sbApi('/functions/v1/receipt-ocr',{method:'POST',data:image});
    if(seq!==receiptPhotoOpenSeq)return;
    const parsed=ocrExtractReceipt(result?.text||'',result?.layoutLines||[]);
    if(!parsed.items.length){receiptEl('editPhotoStatus').textContent='再OCRから商品を見つけられませんでした。写真を見ながら手入力してください。';return;}
    receiptOCRFromRescan={purchaseId:currentEditPurchase.id,parsed};
    currentEditPurchase.receiptOcrText=ocrRedactPrivateText(String(result.text||'').slice(0,30000));
    receiptEl('editOcrText').textContent=currentEditPurchase.receiptOcrText;
    receiptEl('editReceiptAudit').innerHTML='<h3>レシート金額の照合（再OCR結果・未保存）</h3>'+receiptAuditHTML(parsed,currentEditPurchase);
    receiptEl('editPhotoStatus').textContent=`再OCRで${parsed.items.length}商品行・${parsed.reconciliation.parsedCount}点を検出しました。下の「OCR原文から明細を再作成」を押し、写真と照合して保存してください。`;
  }catch(e){receiptEl('editPhotoStatus').textContent='再OCRに失敗：'+e.message;}
  finally{receiptPhotoBusy=false;receiptUpdateRotationButton();}
}

function receiptClearPhotoInEditor(){
  receiptPhotoOpenSeq++;
  receiptPhotoSignedUrl='';receiptPhotoZoom=1;receiptPhotoOriginalBlob=null;receiptPhotoRotatedBase64=null;receiptPhotoRotation=0;receiptOCRFromRescan=null;receiptRevokePreview();
  receiptUpdateRotationButton();
  receiptEl('editReceiptReference').classList.remove('has-photo');
  const img=receiptEl('editReceiptImage');img.hidden=true;img.removeAttribute('src');
  receiptEl('editReceiptPhotoMessage').hidden=false;
  receiptEl('editReceiptPhotoMessage').textContent='保存済み写真はありません。必要なら下から追加できます。';
  receiptEl('editPhotoZoomValue').textContent='100%';
  const frame=receiptEl('editReceiptImageFrame');if(frame){frame.style.width='';frame.style.height='';}
  receiptEl('editPhotoAttach').value='';
  receiptEl('editReceiptRepairExample').hidden=true;
}
window.receiptClearPhotoInEditor=receiptClearPhotoInEditor;
async function receiptShowPhotoInEditor(p){
  receiptClearPhotoInEditor();
  const seq=receiptPhotoOpenSeq;
  receiptEl('editOcrText').textContent=p.receiptOcrText?ocrRedactPrivateText(p.receiptOcrText):'この購入にはOCR原文が保存されていません。';
  receiptShowAuditInEditor(p);
  receiptToggleVerifiedRepair(p);
  receiptEl('editPhotoStatus').textContent='原本写真はログインしている本人のみ閲覧できます。保存期間は約30日です。';
  if(!p.receiptImagePath)return;
  receiptEl('editReceiptPhotoMessage').textContent='非公開の写真を読み込んでいます…';
  try{
    const url=await window.sbGetReceiptImageUrl(p);
    if(seq!==receiptPhotoOpenSeq)return;
    receiptPhotoSignedUrl=url;
    const img=receiptEl('editReceiptImage');img.onload=()=>{if(seq===receiptPhotoOpenSeq){img.hidden=false;receiptEl('editReceiptPhotoMessage').hidden=true;receiptEl('editReceiptReference').classList.add('has-photo');receiptApplyVisualRotation();}};
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
  const zoom=n=>{receiptPhotoZoom=Math.max(.5,Math.min(3,receiptPhotoZoom+n));receiptApplyVisualRotation();};
  receiptEl('editPhotoRotateLeft').onclick=()=>receiptRotatePhoto(-90);
  receiptEl('editPhotoRotateRight').onclick=()=>receiptRotatePhoto(90);
  receiptEl('editPhotoSaveRotation').onclick=receiptSaveRotation;
  receiptEl('editPhotoRerunOCR').onclick=receiptRerunOCRFromPhoto;
  receiptEl('editPhotoZoomOut').onclick=()=>zoom(-.25);
  receiptEl('editPhotoZoomIn').onclick=()=>zoom(.25);
  receiptEl('editPhotoNewTab').onclick=()=>{if(receiptPhotoSignedUrl)window.open(receiptPhotoSignedUrl,'_blank','noopener,noreferrer');else receiptEl('editPhotoStatus').textContent='表示できる写真がありません';};
  window.addEventListener('resize',()=>receiptApplyVisualRotation());
  const redoParse=()=>{
    if(!currentEditPurchase?.receiptOcrText)return receiptEl('editPhotoStatus').textContent='この購入には保存されたOCR原文がありません';
    const parsed=(receiptOCRFromRescan?.purchaseId===currentEditPurchase.id?receiptOCRFromRescan.parsed:null)||ocrExtractReceipt(currentEditPurchase.receiptOcrText);
    if(!parsed.items.length)return receiptEl('editPhotoStatus').textContent='原文から商品を特定できませんでした。写真を見ながら手動で明細を入力してください';
    const currentRows=editGet('editItems').children.length;
    const originalItems=currentEditPurchase.items||[];
    const used=new Set();
    const prepared=parsed.items.map(candidate=>{
      const{name,amount,qty,unit}=candidate;
      const[category,subcategory]=guessCategory(name);
      const draft={id:uid(),name,canonical:normalize(name),amount,qty:qty||1,size:null,unit:unit||'個',category,subcategory,origin:'',state:'',allocations:[{month:String(currentEditPurchase.date||today()).slice(0,7),amount,quantity:null}]};
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
      return{item:{...match,...learned,id:match.id,name:learned.name,canonical:learned.canonical,amount,qty:qty||1,size:match.size,unit:unit||match.unit,origin:match.origin,state:match.state,allocations:plans.map(a=>({...a,quantity:Number(match.qty)===Number(qty)?a.quantity:null}))},preserved:true};
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
    receiptEl('editReceiptAudit').innerHTML='<h3>レシート金額の照合（新しい解析候補・未保存）</h3>'+receiptAuditHTML(parsed,{...currentEditPurchase,items:parsed.items});
  };
  receiptEl('editOcrRetryParse').onclick=redoParse;
  receiptEl('editOcrRetryParseTop').onclick=redoParse;
  receiptEl('editReceiptRepairExample').onclick=receiptApplyVerifiedMaruetsuRepair;
  queueSummary();
}
receiptInit();
