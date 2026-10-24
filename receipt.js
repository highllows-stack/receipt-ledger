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
    reviewStatus:warnings.length?'needs_review':'ok',receiptOcrText:ocrEvidenceStore(result.text||'',result.layoutLines||[])};
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
        else if(out.status==='review'){review++;lastReview=out.purchaseId;receiptStates.set(file,`要確認として写真付き保存：${out.parsed.items.length}商品候補 ／ ${out.parsed.reconciliation.allocatedTax>0?'税抜'+yen(out.parsed.reconciliation.rawSum)+'＋税'+yen(out.parsed.reconciliation.allocatedTax)+'＝':''}税込明細 ${yen(out.parsed.lineSum)} ／ レシート ${out.parsed.total==null?'不明':yen(out.parsed.total)}${out.parsed.reconciliation.derivedTotal!=null?'（参考計算）':''}`);}
        else{success++;receiptStates.set(file,`照合OK・写真付き登録：${out.parsed.items.length}商品 ／ ${out.parsed.reconciliation.allocatedTax>0?'消費税'+yen(out.parsed.reconciliation.allocatedTax)+'を自動配分 ／ ':''}税込 ${yen(out.parsed.lineSum)}`);}
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
  const savedReceipt=Number(purchase?.receiptTotal);
  const savedReceiptMismatch=purchase?.receiptTotal!=null&&Number.isFinite(savedReceipt)&&
    a.effectiveTotal!=null&&Math.abs(savedReceipt-a.effectiveTotal)>.01;
  const details=a.explanations.map(line=>`<li>${esc(line)}</li>`).join('');
  const excluded=parsed.ignoredLines.slice(0,16).map(line=>`<li>${esc(ocrRedactPrivateText(line))}</li>`).join('');
  return `<div class="audit-status ${a.status==='match'?'audit-ok':'audit-review'}">${status}</div>
    <div class="audit-figures">
      <div><small>OCR商品明細</small><strong>${parsed.items.length}行</strong></div>
      <div><small>印字点数／解析点数</small><strong>${a.printedCount??'不明'}／${a.parsedCount}点</strong></div>
      <div><small>読取商品金額（税抜の可能性）</small><strong>${money(a.rawSum)}</strong></div>
      <div><small>印字された小計</small><strong>${money(a.subtotal)}</strong></div>
      <div><small>印字された消費税</small><strong>${money(a.observedTax)}</strong></div>
      <div><small>税込合計の判定根拠</small><strong>${esc(a.totalSource||'不明')}</strong></div>
      <div><small>加算した消費税</small><strong>${money(a.allocatedTax)}</strong></div>
      <div><small>税込明細の合計</small><strong>${money(a.itemSum)}</strong></div>
      <div><small>レシート印字の合計</small><strong>${money(a.printedTotal)}</strong></div>
      <div><small>税込明細と印字合計の差</small><strong>${a.printedTotal==null?'不明':money(a.printedTotal-a.itemSum)}</strong></div>
    </div><p class="audit-note">${esc(description)}。${a.observedTax!=null?'印字された税額 '+money(a.observedTax)+'。':''}${a.taxLegend?' '+esc(a.taxLegend)+'。':''}${a.derivedTotal!=null?' 推定税込合計 '+money(a.derivedTotal)+'（レシート印字合計は未確認）。':''}${a.discountSum?' 商品に紐づいた値引き '+money(a.discountSum)+' を控除済み。':''}</p>
    ${savedReceiptMismatch?`<p class="audit-saved-warning"><strong>保存済みのレシート合計 ${money(savedReceipt)} は、新しい照合の参考合計 ${money(a.effectiveTotal)} と異なります。</strong> 預り金などの誤認識の可能性があります。明細の再作成または写真照合済みの修正候補を確認し、最後に「変更を保存」してください。</p>`:''}
    ${changed?`<p class="audit-saved-warning">現在の保存済み明細 ${money(savedSum)} と、新解析 ${money(a.itemSum)} が異なります。**再作成**ボタンで候補を確認後に取り込めます（保存前は履歴に影響しません）。</p>`.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>'):''}
    ${a.printedCount!=null&&a.parsedCount<a.printedCount?'<p class="audit-saved-warning">OCR原文から読み落とされた商品は、無料再解析だけでは元に戻りません。写真から入力するか、下の「OCR原文の文字を訂正」で補ってください。</p>':''}
    ${details?`<ul class="audit-reasons">${details}</ul>`:''}
    ${parsed.items.length?`<details class="audit-ignored"><summary>商品ごとの税抜金額・加算税額・税込金額を確認</summary><div class="audit-table-wrap"><table class="audit-table"><thead><tr><th>商品</th><th>数量</th><th>税率・根拠</th><th>読取額</th><th>加算税</th><th>税込</th></tr></thead><tbody>${parsed.items.map(item=>`<tr><td>${esc(item.name)}</td><td>${item.qty||1}</td><td>${item.taxRateResolved?item.taxRateResolved+'%':'未確定'}<small>${esc(item.taxRateSource||'')}</small></td><td>${money(item.rawAmount)}</td><td>${money(item.taxAdded||0)}</td><td><strong>${money(item.amount)}</strong></td></tr>`).join('')}</tbody></table></div></details>`:''}
    ${excluded?`<details class="audit-ignored"><summary>商品として登録しなかった行を確認（${parsed.ignoredLines.length}行）</summary><ul>${excluded}</ul></details>`:''}`;
}
function receiptShowAuditInEditor(p){
  const panel=receiptEl('editReceiptAudit');if(!panel)return;
  // Prefer generic OCR evidence over a receipt-specific manual rescue path.
  // If the old OCR text itself was incomplete, offer the verified example fallback.
  if(receiptIsMaruetsuNetOnly(p)&&!p?.receiptOcrText){panel.innerHTML='<h3>レシート金額の照合</h3><div class="audit-status audit-review">税抜小計1,600円のまま登録されています。保存写真の税込合計は1,728円です。</div><p class="audit-note">今回は写真照合済み修正ボタンでも補正できます。</p>';return;}
  if(!p?.receiptOcrText){panel.innerHTML='<h3>レシート金額の照合</h3><p class="muted">この履歴にOCR原文がありません。レシート写真と明細合計を比較してください。</p>';return;}
  try{panel.innerHTML='<h3>レシート金額の照合</h3>'+receiptAuditHTML(ocrExtractReceipt(p.receiptOcrText),p);}
  catch(e){panel.innerHTML='<h3>レシート金額の照合</h3><p class="muted">再解析できませんでした。写真で内容を確認してください。</p>';console.error(e);}
}
// One-time, explicitly confirmed rescue of the particular receipt supplied as a photo
// by the user. This is not a replacement for general OCR and is NEVER applied silently.
// Two known states of the photo verified by the user:
// (a) old OCR: 12 false rows and 14,422 yen, or
// (b) after removing false rows: 9 genuine rows still mistakenly at 1,600 yen NET.
function receiptIsKnownMaruetsu(p){
  return !!p&&p.date==='2026-10-23'&&/maruetsu|マルエツ/i.test(p.merchant||'');
}
function receiptIsMaruetsuNetOnly(p){
  if(!receiptIsKnownMaruetsu(p)||p.items?.length!==9)return false;
  const expected=[[/かぼちゃ/,316],[/木綿豆腐/,108],[/ブルーベリー/,148],
    [/ドリンクゼリー/,108],[/エナジー180M/i,108],[/エナジー180R/i,108],
    [/ドリンクゼリー/,108],[/キャベツガリバタ/,447],[/にんにく炒め/,149]];
  const used=new Set();
  for(const [pattern,amount] of expected){
    const index=p.items.findIndex((item,i)=>!used.has(i)&&pattern.test(String(item.name||''))&&Math.abs(Number(item.amount)-amount)<.01);
    if(index===-1)return false;
    used.add(index);
  }
  return p.items.reduce((n,i)=>n+Number(i.amount||0),0)===1600;
}
function receiptIsUserVerifiedMaruetsu(p){
  if(!receiptIsKnownMaruetsu(p))return false;
  const oldFalse=Number(p.receiptTotal)===14422&&p.items?.length>=10&&
    p.items.some(i=>/(?:WAON|11点|レジ\s*No|レジ番号)/i.test(i.name));
  return oldFalse||receiptIsMaruetsuNetOnly(p);
}
// This photo was supplied by the user and verified independently. Only offer
// the one-time rescue for the known incorrectly parsed October 24 receipt.
function receiptIsOctober24DiscountMisread(p){
  if(!p||p.date!=='2026-10-24'||!/maruetsu|マルエツ/i.test(p.merchant||''))return false;
  if(!Array.isArray(p.items)||p.items.length<2||p.items.length>8)return false;
  const names=p.items.map(i=>String(i.name||'')).join(' ');
  const sum=p.items.reduce((n,i)=>n+Number(i.amount||0),0);
  // Avoid suggesting this exact-photo repair for a second unrelated purchase at
  // the same shop/date. Require recognizable purchased items and known misread sums.
  const hints=[/豚肉|生姜焼|ロース/.test(names),/キャベツ/.test(names),/ウインナー/.test(names)];
  const hits=hints.filter(Boolean).length;
  const badSum=[308,699,704,808,576,622].some(x=>Math.abs(sum-x)<.01);
  const labels=/割引|値引|30[%％]/.test(names);
  const raw=ocrEvidenceText(String(p.receiptOcrText||'')).replace(/\s/g,'');
  const originalEvidence=/(?:576|622)/.test(raw)&&/(?:8[%％]|外税|合計|小計|割引)/.test(raw);
  // Already-correct receipt needs no rescue.
  const corrected=p.items.length===3&&Math.abs(sum-622)<.01&&
    hints.every(Boolean)&&Math.abs(Number(p.receiptTotal)-622)<.01;
  if(corrected)return false;
  return hits>=2&&(badSum||labels||originalEvidence);
}
function receiptOfferOctober24Repair(p){
  const button=receiptEl('editReceiptRepairOct24');
  if(button)button.hidden=!receiptIsOctober24DiscountMisread(p);
}
function receiptRepairOctober24Discount(){
  const p=currentEditPurchase;
  if(!receiptIsOctober24DiscountMisread(p))return;
  // 384 - 116 + 109 + 199 = net 576; printed VAT 46; gross 622.
  const goods=[
    {name:'豚肉ロース生姜焼',raw:268,category:'食材',subcategory:'肉類'},
    {name:'キャベツ',raw:109,category:'食材',subcategory:'野菜'},
    {name:'ウインナー5本',raw:199,category:'食材',subcategory:'肉類'}
  ];
  const shares=ocrTaxShares(goods.map(x=>x.raw*8),46);
  const gross=goods.map((x,i)=>({...x,amount:x.raw+shares[i]}));
  if(gross.reduce((n,i)=>n+i.amount,0)!==622)throw Error('照合できませんでした。');
  const text='写真と照合済みの2026年10月24日のレシートを、次の明細候補に置き換えます。\n'
    +'豚肉ロース 384円 − 自動割引 116円 ＝ 税抜268円\n'
    +'キャベツ 税抜109円\nウインナー5本 税抜199円\n'
    +'小計576円 ＋ 消費税46円 ＝ 税込622円\n\n'
    +'購入日と他の履歴は変更しません。月別配分はこの3行について購入月に初期化されます。\n'
    +'「変更を保存」を押すまで履歴には反映されません。続けますか？';
  if(!confirm(text))return;
  const month=p.date.slice(0,7),container=editGet('editItems');
  container.innerHTML='';
  for(const x of gross){
    container.append(editNewRow({id:uid(),name:x.name,canonical:normalize(x.name),amount:x.amount,
      qty:1,size:null,unit:'個',category:x.category,subcategory:x.subcategory,
      origin:'',state:'',allocations:[{month,amount:x.amount,quantity:null}]}));
  }
  editGet('editReceiptTotal').value='622';editGet('editReview').value='ok';editTotals();
  receiptEl('editReceiptAudit').innerHTML='<h3>写真照合済みの明細候補（未保存）</h3>'+
    '<div class="audit-status audit-ok">豚肉の割引116円を控除・小計576円＋印字税46円＝税込622円</div>'+
    '<p class="audit-note">印字された3点と一致。会員番号・日付時刻・お釣りは商品に含めていません。' +
    '商品の税込金額は 289円・118円・215円です。保存前に確認してください。</p>';
  receiptEl('editPhotoStatus').textContent='写真照合済みの候補を設定しました。画面下の「変更を保存」で確定してください。';
  receiptEl('editReceiptRepairOct24').hidden=true;
}
function receiptIntegerCents(value){return Math.round(Number(value)*100)}
function receiptTaxAllocation(weights,taxCents){
  // Use integer cents throughout, and deterministic largest remainder rounding.
  if(!Number.isSafeInteger(taxCents)||taxCents<0||!weights.length)throw Error('印字税額を確認してください');
  const total=weights.reduce((n,w)=>n+w,0);
  if(!Number.isSafeInteger(total)||total<=0||weights.some(w=>!Number.isSafeInteger(w)||w<0))throw Error('明細金額を確認してください');
  const fractions=weights.map((w,i)=>({i,raw:taxCents*w/total}));
  const result=fractions.map(x=>Math.floor(x.raw));
  const remain=taxCents-result.reduce((n,v)=>n+v,0);
  const order=fractions.map((x,i)=>({i,f:x.raw-result[i]})).sort((a,b)=>b.f-a.f||a.i-b.i);
  for(let i=0;i<remain;i++)result[order[i%order.length].i]++;
  return result;
}
function receiptPrintedTaxShares(weightsInCents,taxInCents){
  // In Japanese supermarket receipts, line prices and printed VAT are in whole yen.
  // Allocate in whole yen when possible. Use cents only for fractional-price records.
  if(taxInCents%100===0&&weightsInCents.every(v=>v%100===0))
    return receiptTaxAllocation(weightsInCents,taxInCents/100).map(x=>x*100);
  return receiptTaxAllocation(weightsInCents,taxInCents);
}
// This edits ONLY the open, unsaved form, never the stored purchase or original photo.
function receiptApplyTaxToEditedItems(taxYen,expectedTotalYen,verified=false){
  const rows=[...editGet('editItems').querySelectorAll('.purchase-edit-row')];
  const amounts=rows.map(row=>receiptIntegerCents(row.querySelector('.e-amount').value));
  const taxCents=receiptIntegerCents(taxYen),totalCents=receiptIntegerCents(expectedTotalYen);
  const baseCents=amounts.reduce((n,v)=>n+v,0);
  if(!rows.length||rows.some(row=>/未読み取り|確認して入力/.test(row.querySelector('.e-name').value)))throw Error('未確認の商品があります。先に明細を修正してください');
  if(!Number.isSafeInteger(taxCents)||taxCents<=0||!Number.isSafeInteger(totalCents)||totalCents<=0)throw Error('税額・税込合計を正しく入力してください');
  if(baseCents===totalCents)throw Error('すでに税込合計と一致しています。二重加算を防ぐため中止しました');
  if(baseCents+taxCents!==totalCents)throw Error('現在の明細合計＋印字税額が、入力した税込合計と一致しません。自動補正はしません');
  const shares=receiptPrintedTaxShares(amounts,taxCents);
  const preview=rows.map((row,i)=>`${row.querySelector('.e-name').value}: ${yen(amounts[i]/100)} → ${yen((amounts[i]+shares[i])/100)}`).join('\n');
  if(!confirm('すべての対象明細が税抜表示であり、印字税額がこの商品群に対応することを写真で確認してください。\n'
    +`税抜小計 ${yen(baseCents/100)} ＋ 印字税 ${yen(taxCents/100)} ＝ 税込 ${yen(totalCents/100)}\n\n`
    +preview+'\n\n保存済み履歴は「変更を保存」を押すまで変更されません。続けますか？'))return false;
  // Preflight every month allocation before mutating any editing row.
  const updates=rows.map((row,i)=>{
    const planRows=[...row.querySelectorAll('.accounting-row')];
    if(!planRows.length)throw Error('計上月がありません。先に計上月を設定してください');
    const plans=planRows.map(r=>({month:r.querySelector('.a-month').value,amount:Number(r.querySelector('.a-amount').value),
      quantity:r.querySelector('.a-qty').value===''?null:Number(r.querySelector('.a-qty').value)}));
    const planWeights=plans.map(x=>receiptIntegerCents(x.amount));
    if(planWeights.reduce((a,b)=>a+b,0)!==amounts[i])throw Error('月別配分合計と商品金額が一致しません。先に月別配分を確認してください');
    const extra=receiptPrintedTaxShares(planWeights,shares[i]);
    return{row,newCents:amounts[i]+shares[i],plans:plans.map((x,k)=>({...x,amount:(planWeights[k]+extra[k])/100}))};
  });
  for(const update of updates){
    update.row.querySelector('.e-amount').value=(update.newCents/100).toString();
    editSetAllocations(update.row,update.plans);
  }
  editGet('editReceiptTotal').value=(totalCents/100).toString();
  editGet('editReview').value='needs_review';
  editTotals();
  receiptEl('editReceiptAudit').innerHTML='<h3>写真と照合した税込換算（未保存）</h3>'+
    `<div class="audit-status audit-ok">${rows.length}商品行・税抜${yen(baseCents/100)}＋印字税${yen(taxCents/100)}＝税込${yen(totalCents/100)}</div>`+
    '<p class="audit-note">印字税額を比例配分しました。購入数量と月別の計上数量は維持しています。商品ごとの税率・金額は写真で確認してください。</p>';
  receiptEl('editPhotoStatus').textContent='税込金額を編集欄へセットしました。「変更を保存」を押すまでは履歴に反映されません。';
  receiptEl('editTaxPrintedTax').value='';
  receiptEl('editTaxPrintedTotal').value='';
  receiptEl('editTaxToolStatus').textContent=verified?'写真照合済みの税額を反映しました。明細を確認して保存してください。':'金額を税込に按分しました。写真で確認して保存してください。';
  receiptEl('editReceiptRepairExample').hidden=true;
  receiptEl('editReceiptRepairOct24').hidden=true;
  return true;
}
function receiptSetTaxToolInputs(p){
  const isNet=receiptIsMaruetsuNetOnly(p);
  receiptEl('editTaxPrintedTax').value=isNet?'128':'';
  receiptEl('editTaxPrintedTotal').value=isNet?'1728':'';
  receiptEl('editTaxToolStatus').textContent=isNet?
    'この写真では税抜小計1,600円＋税128円＝税込1,728円です。確認のうえ税込換算してください。':
    'すべての商品が税抜で、印字税額と税込合計が分かる場合のみ使用します。8%と10%が混在する場合、税率別確認が必要です。';
}
function receiptApplyPrintedTax(){
  try{receiptApplyTaxToEditedItems(receiptEl('editTaxPrintedTax').value,receiptEl('editTaxPrintedTotal').value)}
  catch(e){receiptEl('editTaxToolStatus').textContent='税込換算できません：'+e.message;}
}

function receiptApplyVerifiedMaruetsuRepair(){
  const p=currentEditPurchase;
  if(!receiptIsUserVerifiedMaruetsu(p))return;
  if(receiptIsMaruetsuNetOnly(p)){
    try{
      if(receiptApplyTaxToEditedItems(128,1728,true)){
        // Only fill unclassified categories; never overwrite the user's edits.
        const choices=[[/かぼちゃ/,'食材','野菜'],[/木綿豆腐/,'食材','豆製品'],
          [/ブルーベリー/,'食材','果物'],[/ドリンクゼリー/,'食品・飲料','その他'],
          [/エナジー180[MR]/i,'食品・飲料','飲料'],[/キャベツガリバタ/,'食材','野菜'],
          [/にんにく炒め/,'食品・飲料','惣菜・弁当']];
        for(const row of editGet('editItems').querySelectorAll('.purchase-edit-row')){
          const major=row.querySelector('.e-category'),minor=row.querySelector('.e-subcategory');
          if(major.value!=='その他')continue;
          const name=row.querySelector('.e-name').value;
          const choice=choices.find(c=>c[0].test(name));if(!choice)continue;
          major.value=choice[1];major.dispatchEvent(new Event('change',{bubbles:true}));
          minor.value=choice[2];
        }
        editTotals();
      }
    }
    catch(e){receiptEl('editTaxToolStatus').textContent='税込補正できません：'+e.message;}
    return;
  }
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
  receiptEl('editReceiptRepairOct24').hidden=true;
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
    currentEditPurchase.receiptOcrText=ocrEvidenceStore(result.text||'',result.layoutLines||[]);
    receiptEl('editOcrText').textContent=ocrEvidenceText(currentEditPurchase.receiptOcrText);
    receiptEl('editOcrEditable').value=ocrEvidenceText(currentEditPurchase.receiptOcrText);
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
  receiptEl('editOcrEditable').value='';
  receiptEl('editOcrCorrectionStatus').textContent='';
  receiptEl('editReceiptRepairExample').hidden=true;
  receiptEl('editReceiptRepairOct24').hidden=true;
}
window.receiptClearPhotoInEditor=receiptClearPhotoInEditor;
async function receiptShowPhotoInEditor(p){
  receiptClearPhotoInEditor();
  const seq=receiptPhotoOpenSeq;
  receiptEl('editOcrText').textContent=p.receiptOcrText?ocrEvidenceText(p.receiptOcrText):'この購入にはOCR原文が保存されていません。';
  receiptEl('editOcrEditable').value=ocrEvidenceText(p.receiptOcrText||'');
  receiptShowAuditInEditor(p);
  receiptToggleVerifiedRepair(p);
  receiptOfferOctober24Repair(p);
  receiptSetTaxToolInputs(p);
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
    const selectedPreview=receiptOCRFromRescan?.purchaseId===currentEditPurchase.id?receiptOCRFromRescan:null;
    const parsed=selectedPreview?.parsed||ocrExtractReceipt(currentEditPurchase.receiptOcrText);
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
    if(selectedPreview?.correctedText!==undefined){
      currentEditPurchase.receiptOcrText=ocrEvidenceStore(selectedPreview.correctedText);
      receiptEl('editOcrText').textContent=ocrEvidenceText(currentEditPurchase.receiptOcrText);
    }
    editGet('editReview').value=parsed.reconciliation.status==='match'?'ok':'needs_review';
    editTotals();
    receiptEl('editPhotoStatus').textContent=`明細を ${parsed.items.length}件に入れ替えました（${preserved}件は既存の月別配分を保持）。写真で品名・税率・税込金額と月別配分を確認してから「変更を保存」を押してください。`;
    receiptEl('editReceiptAudit').innerHTML='<h3>レシート金額の照合（新しい解析候補・未保存）</h3>'+receiptAuditHTML(parsed,{...currentEditPurchase,items:parsed.items});
  };
  receiptEl('editOcrCorrectPreview').onclick=()=>{
    if(!currentEditPurchase)return;
    const corrected=receiptEl('editOcrEditable').value.trim();
    if(!corrected){receiptEl('editOcrCorrectionStatus').textContent='文字を入力してください。';return;}
    try{
      const parsed=ocrExtractReceipt(corrected);
      if(!parsed.items.length){receiptEl('editOcrCorrectionStatus').textContent='商品候補を検出できませんでした。商品名と金額を一行に入力してみてください。';return;}
      receiptOCRFromRescan={purchaseId:currentEditPurchase.id,parsed,correctedText:corrected};
      receiptEl('editReceiptAudit').innerHTML='<h3>訂正したOCR原文の照合（まだ未保存）</h3>'+receiptAuditHTML(parsed,currentEditPurchase);
      receiptEl('editOcrCorrectionStatus').textContent=`${parsed.items.length}明細・${parsed.reconciliation.parsedCount}点、税込候補 ${parsed.total==null?'不明':yen(parsed.total)}。内容を確認後、上の「税率・税込を自動判定して明細を再作成」を押してください。最後に「変更を保存」が必要です。`;
    }catch(e){receiptEl('editOcrCorrectionStatus').textContent='再解析できません：'+e.message;}
  };
  receiptEl('editOcrRetryParse').onclick=redoParse;
  receiptEl('editOcrRetryParseTop').onclick=redoParse;
  receiptEl('editReceiptRepairExample').onclick=receiptApplyVerifiedMaruetsuRepair;
  receiptEl('editReceiptRepairOct24').onclick=receiptRepairOctober24Discount;
  receiptEl('editApplyPrintedTax').onclick=receiptApplyPrintedTax;
  queueSummary();
}
receiptInit();
