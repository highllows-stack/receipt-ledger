'use strict';
// Receipt line parser. No extra paid AI: process Vision dense-text OCR + positional rows.
// A tax, subtotal or payment line MUST NOT become a product merely because it ends in a number.
const OCR_TOTAL_RE=/^(?:\s*[＊*※]?\s*)(?:総\s*合\s*計|合\s*計|お?買\s*上\s*合\s*計|お?支\s*払\s*金\s*額|ご?請\s*求\s*額|お?会\s*計)(?:\s|[:：￥¥]|$)/i;
const OCR_NON_ITEM_RE=/(?:消\s*費\s*税|内\s*税|外\s*税|税\s*額|税\s*率|課\s*税|非\s*課\s*税|軽\s*減|税\s*抜|税\s*込|\d{1,2}\s*[%％]|[%％]\s*対\s*象|対\s*象\s*額|合\s*計|小\s*計|お?支\s*払|お?預|お?釣|釣\s*銭|現\s*金|クレジット|クレジットカード|電子マネー|支払い|決済|レジ|登録番号|インボイス|領収|レシート|ポイント|クーポン|値\s*引|割\s*引|獲得|残\s*高|お?買い?上げ?点数|品目数|単価合計|税区分|明細番号|取引番号|TEL\b|FAX\b|電話|〒|No\.?\s*\d{4,}|伝票|担当者)/i;
const OCR_NOT_NAME_RE=/^(?:[\d\s￥¥,.\/\-:年月日時分秒\(\)]+|https?:\/\/|www\.|\*+|=+|[0-9]{7,}|\d{1,2}\s*[時:]\s*\d{2})$/i;
function ocrMoney(s){return Number(String(s||'').replace(/[￥¥円,，\s]/g,''));}
function ocrLine(s){return String(s||'').normalize('NFKC').replace(/[\t\u3000]+/g,' ').replace(/\s+/g,' ').trim();}
function ocrNonItem(s){
  const t=ocrLine(s);
  return !t||OCR_NON_ITEM_RE.test(t)||OCR_TOTAL_RE.test(t)||/^[\d.,￥¥円\s-]+$/.test(t)||
    /^20\d{2}[\/.年-]/.test(t)||/^\d{1,2}[:：]\d{2}(?:[:：]\d{2})?$/.test(t)||
    /^(?:[\d -]{10,}|[0-9]{2,4}[-\/][0-9]{1,2}[-\/][0-9]{1,2})$/.test(t);
}
function ocrValidName(s){
  const t=ocrLine(s).replace(/^\s*[＊*※]\s*/,'');
  if(ocrNonItem(t)||OCR_NOT_NAME_RE.test(t)||t.length>100)return false;
  return (t.length>=2||/^[米卵塩酒茶]$/.test(t))&&/[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t)&&
    !/^(?:JAN|PLU|コード|商品コード|商品番号|バーコード|会員番号|登録NO|店舗番号)/i.test(t);
}
const OCR_PRICE_END=/(?:[￥¥]\s*)?((?:\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.\d{1,2})?)\s*円?\s*[＊*※]?\s*$/;
const OCR_ONLY_PRICE=/^[￥¥]?\s*((?:\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.\d{1,2})?)\s*円?\s*[＊*※]?\s*$/;
function ocrCandidate(line){
  const s=ocrLine(line);
  if(ocrNonItem(s))return null;
  const m=s.match(OCR_PRICE_END);
  if(!m||m.index===0)return null;
  let name=s.slice(0,m.index).replace(/[￥¥]\s*$/,'').replace(/^[＊*※\s]+/,'').trim();
  name=name.replace(/\s+(?:[xX×*]\s*\d+|\d+\s*[点個])\s*$/,'').trim();
  if(!ocrValidName(name))return null;
  const amount=ocrMoney(m[1]);
  if(!Number.isFinite(amount)||amount<=0||amount>500000)return null;
  // Do not infer that a quantity or product-code row is a price-bearing product.
  if(/^[\d]{8,14}(?:\s|$)/.test(name))name=name.replace(/^\d{8,14}\s*/, '');
  if(!ocrValidName(name))return null;
  return {name,amount,rawLine:s};
}
function ocrParseItemLines(sourceLines){
  const lines=sourceLines.map(l=>typeof l==='string'?l:l?.text||'').map(ocrLine).filter(Boolean);
  const items=[];const ignored=[];const limit=lines.length;
  for(let i=0;i<limit;i++){
    const s=lines[i];
    if(ocrNonItem(s)){ignored.push(s);continue;}
    let item=ocrCandidate(s);
    if(!item && ocrValidName(s) && i+1<limit){
      const next=lines[i+1],only=next.match(OCR_ONLY_PRICE);
      if(only&& !ocrNonItem(s+' '+(next.includes('%')?'%':''))){
        const amount=ocrMoney(only[1]);
        if(amount>0&&amount<=500000){item={name:s,amount,rawLine:s+' '+next};i++;}
      }
      // Two lines where a quantity marker intervenes: 商品名 / 1点 x / ¥198
      else if(i+2<limit&&/^(?:\d+\s*(?:点|個)|[xX×*]\s*\d+|\d+\s*[xX×*]\s*\d+)$/i.test(next)){
        const price=lines[i+2].match(OCR_ONLY_PRICE);
        if(price){const amount=ocrMoney(price[1]);if(amount>0&&amount<=500000){item={name:s,amount,rawLine:s+' / '+next+' / '+lines[i+2]};i+=2;}}
      }
    }
    if(item)items.push(item);
    else ignored.push(s);
  }
  return {items:items.slice(0,100),ignored};
}
function ocrFindDate(lines){
  const text=lines.join(' ');
  let m=text.match(/(?:20\d{2})[年\/.\-]\s*\d{1,2}[月\/.\-]\s*\d{1,2}日?/);
  if(!m)return null;
  const parts=m[0].match(/(20\d{2})[年\/.\-]\s*(\d{1,2})[月\/.\-]\s*(\d{1,2})/);
  if(!parts)return null;
  const y=Number(parts[1]),mo=Number(parts[2]),day=Number(parts[3]);
  const d=new Date(Date.UTC(y,mo-1,day));
  if(d.getUTCFullYear()!==y||d.getUTCMonth()!==mo-1||d.getUTCDate()!==day)return null;
  return [parts[1],parts[2].padStart(2,'0'),parts[3].padStart(2,'0')].join('-');
}
function ocrFindTotal(lines){
  for(let i=0;i<lines.length;i++){
    const s=ocrLine(lines[i]);
    if(!OCR_TOTAL_RE.test(s)||/税|対象|税抜|小計|点数/.test(s))continue;
    const right=s.replace(OCR_TOTAL_RE,'');
    const m=right.match(OCR_PRICE_END)||lines[i+1]?.match(OCR_ONLY_PRICE);
    if(m){const a=ocrMoney(m[1]);if(Number.isFinite(a)&&a>0&&a<10000000)return a;}
  }
  return null;
}
function ocrPickMerchant(lines){
  const s=lines.slice(0,8).map(ocrLine).find(s=>s.length>=2&&s.length<=70&&
    !ocrNonItem(s)&&!ocrCandidate(s)&&!/[￥¥]\s*\d+/.test(s)&&
    !/^(?:[\d\-\/\. :年月日時分秒]+|お客様|ありがとう|いらっしゃい|店舗番号)/.test(s));
  return s||'購入先未設定';
}
function ocrExtractReceipt(raw,layoutLines=[]){
  const textLines=String(raw||'').normalize('NFKC').replace(/[\r\u0000]/g,'').split('\n').map(ocrLine).filter(Boolean);
  const geometryLines=Array.isArray(layoutLines)?layoutLines.slice(0,400).map(l=>ocrLine(typeof l==='string'?l:l?.text||'')).filter(Boolean):[];
  const total=ocrFindTotal(textLines)||ocrFindTotal(geometryLines);
  const textParsed=ocrParseItemLines(textLines),geometryParsed=geometryLines.length?ocrParseItemLines(geometryLines):null;
  const quality=r=>{
    const sum=r.items.reduce((s,i)=>s+i.amount,0);
    const totalMatch=total!==null?Math.max(0,1-Math.abs(total-sum)/Math.max(total,1)):0;
    return r.items.length*3+totalMatch*6-Math.max(0,r.items.length-60)*2;
  };
  const fromLayout=geometryParsed&&quality(geometryParsed)>quality(textParsed)+0.01;
  const chosen=fromLayout?geometryParsed:textParsed;
  const warnings=[];
  const sum=chosen.items.reduce((s,i)=>s+i.amount,0);
  if(!chosen.items.length)warnings.push('商品明細を特定できません。消費税や合計だけを商品として登録せず、写真から明細を入力してください');
  if(total!==null&&chosen.items.length&&Math.abs(total-sum)>Math.max(2,total*0.015))warnings.push('明細合計 '+sum+'円とレシート合計 '+total+'円が一致しません');
  const date=ocrFindDate(textLines)||ocrFindDate(geometryLines);
  if(!date)warnings.push('購入日を判定できませんでした');
  if(chosen.items.length>=100)warnings.push('商品数が多く途中までの読み取りです');
  if(chosen.items.length===1&&total!==null&&sum<total*0.4)warnings.push('商品行が一部しか読めていない可能性があります');
  return {merchant:ocrPickMerchant(textLines),date,total,items:chosen.items,warnings,rawLineCount:textLines.length,
    parsedSource:fromLayout?'位置情報':'OCR文字列',lineSum:sum,ignoredLines:chosen.ignored.slice(0,60)};
}
