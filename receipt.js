'use strict';
// Scans are sent only to an authenticated Supabase Edge Function. Images are not stored.
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
window.receiptQueueChanged=()=>{queueSummary();receiptStatus(pendingImages.length+'枚選択しました。読み取り開始で順番に処理します。');};
function extractImage(file){return new Promise(async(resolve,reject)=>{
  try{
    if(!file.type.startsWith('image/'))throw Error('画像ファイルを指定してください');
    const url=URL.createObjectURL(file);const img=new Image();
    try{
      img.src=url;await img.decode();
      const maxDimension=2000,scale=Math.min(1,maxDimension/Math.max(img.naturalHeight,img.naturalWidth));
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
      canvas.getContext('2d',{alpha:false}).drawImage(img,0,0,canvas.width,canvas.height);
      const data=canvas.toDataURL('image/jpeg',0.84).split(',')[1];
      if(data.length>6_800_000)throw Error('画像が大きすぎます。解像度を下げてください');
      resolve({imageBase64:data,mimeType:'image/jpeg'});
    }finally{URL.revokeObjectURL(url)}
  }catch(e){reject(e)}
});}
async function receiptFingerprint(text){
  const normalized=text.normalize('NFKC').replace(/[\s\u3000]+/g,'').toLowerCase();
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
async function scanOne(file){
  const image=await extractImage(file);
  const result=await sbApi('/functions/v1/receipt-ocr',{method:'POST',data:image});
  if(typeof result?.text!=='string'||!result.text.trim())throw Error('OCRの結果が空です');
  const parsed=ocrExtractReceipt(result.text);
  if(!parsed.items.length)throw Error(parsed.warnings.join('、')||'商品と金額を読み取れませんでした');
  const hash=await receiptFingerprint(result.text);
  if(state.purchases.some(p=>p.receiptFingerprint===hash))return {status:'duplicate',parsed};
  const items=parsed.items.map(({name,amount})=>{
    const [category,subcategory]=guessCategory(name);
    const base={id:uid(),name,canonical:normalize(name),amount,qty:1,size:null,unit:'個',category,subcategory,origin:'',state:''};
    return window.learningApplyOCRItem?.(base)||base;
  });
  const unverified=items.filter(i=>i.smartPrediction?.level!=='high');
  const warnings=[...parsed.warnings];
  if(unverified.length)warnings.push(unverified.length+'商品の分類は推測・未確定です。履歴から確認してください');
  const p={id:uid(),bookId:sbLedger,date:parsed.date||today(),merchant:parsed.merchant,
    source:'receipt',items,receiptTotal:parsed.total,receiptFingerprint:hash,
    reviewStatus:warnings.length?'needs_review':'ok'};
  try{await sbInsert(p)}catch(e){
    if(/duplicate key|23505|unique constraint/i.test(e.message))return {status:'duplicate',parsed};
    throw e;
  }
  return {status:warnings.length?'review':'ok',parsed:{...parsed,warnings}};
}
async function receiptScanAll(){
  if(receiptRunning||sbBusy)return receiptStatus('処理中です。少し待ってください');
  if(!window.cloudMode||!sbSession?.access_token)return receiptStatus('先に「設定」でログインしてください。');
  if(!pendingImages.length)return receiptStatus('レシート画像を選択してください。');
  receiptRunning=true;sbBusy=true;receiptEl('ocrStart').disabled=true;receiptEl('ocrClear').disabled=true;
  let success=0,review=0,failed=0,duplicate=0;
  try{
    for(const file of pendingImages){
      const already=receiptStates.get(file)||'';
      if(/^(登録済|要確認|重複)/.test(already))continue;
      receiptStates.set(file,'読み取り中…');queueSummary();
      try{
        const out=await scanOne(file);
        if(out.status==='duplicate'){duplicate++;receiptStates.set(file,'重複のため登録しませんでした');}
        else if(out.status==='review'){review++;receiptStates.set(file,`要確認として登録（${out.parsed.items.length}商品）：${out.parsed.warnings.join('／')}`);}
        else{success++;receiptStates.set(file,`登録済（${out.parsed.items.length}商品）`);}
      }catch(e){failed++;receiptStates.set(file,'失敗：'+e.message)}
      queueSummary();receiptStatus(`登録${success}件・要確認${review}件・重複${duplicate}件・失敗${failed}件`);
    }
  }finally{
    sbBusy=false;receiptRunning=false;receiptEl('ocrStart').disabled=false;receiptEl('ocrClear').disabled=false;
    if(success+review)await sbLoad();
    receiptStatus(`完了：登録${success}件、要確認${review}件、重複${duplicate}件、失敗${failed}件。失敗した画像は再実行できます。`);
  }
}
function receiptInit(){
  receiptEl('ocrStart').onclick=()=>receiptScanAll().catch(e=>receiptStatus('エラー：'+e.message));
  receiptEl('ocrClear').onclick=()=>{if(receiptRunning)return;pendingImages=[];receiptEl('camera').value='';receiptEl('images').value='';queueSummary();receiptStatus('選択を解除しました')};
  queueSummary();
}
receiptInit();
