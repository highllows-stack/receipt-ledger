'use strict';
// Japanese receipt OCR heuristics: returns candidates, NOT guaranteed transcription accuracy.
const OCR_IGNORE=/^(?:合\s*計|小\s*計|お?会計|計\s*[:：]|合計点数|お?支払|お?預|お?釣|おつり|現金|クレジット|カード|電子マネー|残高|消費税|内税|外税|税額|税抜|税込|軽減|税率|対象額|合計金額|値引|割引|クーポン|ポイント|利用額|獲得|変更|お買上|お買い上げ|領収|レシート|購入点数|TEL|電話|担当|レジ|取引|伝票|会員|合計額|合\s*計額|品目数|時刻|日時|明細)/i;
function ocrMoney(input){return Number(String(input).replace(/[¥￥円,，\s]/g,''))}
function ocrPossibleItemName(s){
  return s.length>=2&&s.length<=80&&/[^0-9,，.．¥￥\s]/.test(s)&&!OCR_IGNORE.test(s)&&
    !/^([〒\d+\-\s()]+|[\d\s/:.\-]+|https?:|www\.|\*+|\-+|\=+|No\.|NO\.)/i.test(s)&&
    !/^20\d{2}[\/\-.年]/.test(s)&&!/[（(]?\d{2,3}%[)）]?/.test(s);
}
function ocrExtractReceipt(raw){
  const lines=String(raw||'').normalize('NFKC').replace(/[\r\u0000]/g,'').split('\n').map(x=>x.trim()).filter(Boolean);
  const dates=lines.join(' ').match(/(20\d{2})[年.\/\-](\d{1,2})[月.\/\-](\d{1,2})日?/);
  let date=null;
  if(dates){const y=Number(dates[1]),m=Number(dates[2]),d=Number(dates[3]);if(m>=1&&m<=12&&d>=1&&d<=31)date=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`}
  let merchant=lines.slice(0,6).find(x=>x.length>=2&&x.length<=50&&!/^(?:[\d\s年月日:/\-.]+|〒|TEL|電話|領収|レシート|No\.|いらっしゃい|ありがとう|合計|レジ)/i.test(x)&&!/[\d,]{3,}\s*円$/.test(x))||'購入先未設定';
  merchant=merchant.replace(/\s{2,}/g,' ').slice(0,70);
  let total=null;
  for(const line of lines){
    if(/^(?:合\s*計|総合計|お支払金額|お買上合計|お買い上げ合計|請求額|ご請求額)/.test(line)){
      const m=line.match(/[¥￥]?([\d,]{2,9})\s*円?\s*$/);
      if(m)total=ocrMoney(m[1]);
    }
  }
  const candidates=[];
  for(let index=0;index<lines.length;index++){
    const line=lines[index].replace(/\s+/g,' ');
    if(OCR_IGNORE.test(line))continue;
    if(/^\d+\s*[点個枚]\s*[×xX*]/.test(line))continue;
    // e.g. "国産鶏もも 398", "牛乳1L ¥238", "納豆 98円"
    let m=line.match(/^(.{2,80}?)\s+[¥￥]?([0-9]{1,3}(?:,[0-9]{3})+|\d{2,6})\s*円?\s*$/);
    // Japanese receipts may have no separating space before currency symbol.
    if(!m)m=line.match(/^(.{2,80}?)[¥￥]([0-9]{1,3}(?:,[0-9]{3})+|\d{2,6})\s*円?\s*$/);
    let name=m?.[1]?.trim(),amount=m?ocrMoney(m[2]):NaN;
    if(!m&&ocrPossibleItemName(line)){
      const priceOnly=lines[index+1]?.replace(/\s+/g,' ').match(/^[¥￥]?([0-9]{1,3}(?:,[0-9]{3})+|\d{2,6})\s*円?\s*$/);
      if(priceOnly){name=line;amount=ocrMoney(priceOnly[1]);index++;}
    }
    if(!name||!ocrPossibleItemName(name)||!Number.isFinite(amount)||amount<1||amount>500000)continue;
    candidates.push({name:name.replace(/^\*\s*/,''),amount});
  }
  // OCR may repeat same item within the receipt; preserve each occurrence.
  const sum=candidates.reduce((s,i)=>s+i.amount,0);
  const warnings=[];
  if(!candidates.length)warnings.push('商品名と金額の組み合わせを取得できませんでした');
  if(date===null)warnings.push('日付を判定できませんでした');
  if(total!==null&&Math.abs(total-sum)>Math.max(5,total*0.08))warnings.push(`明細合計${sum}円とレシート合計${total}円が一致しません`);
  if(candidates.length>50)warnings.push('商品数が多いため確認してください');
  return {merchant,date,total,items:candidates.slice(0,100),warnings,rawLineCount:lines.length};
}
