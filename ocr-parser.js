'use strict';
// くらしのレシート v1.6: OCR evidence-based automatic tax handling.
// OCR text/layout -> product candidates -> tax treatment -> reconciled VAT-inclusive amounts.
// Never turn point-card IDs, subtotals, taxes, payment rows or unknown differences into products.
const OCR_PRICE_END=/(?:[￥¥]\s*)?((?:\d{1,3}(?:,\d{3})+|\d{1,8})(?:\.\d{1,2})?)\s*円?\s*[＊*※]?\s*$/;
const OCR_ONLY_PRICE=/^[＊*※]?\s*[￥¥]?\s*((?:\d{1,3}(?:,\d{3})+|\d{1,8})(?:\.\d{1,2})?)\s*円?\s*[＊*※]?\s*$/;
const OCR_META_PREFIX=/^(?:ポイント|会員|会員カード|お客様|カード(?:番号|No|NO|ID|会員)|会員番号|会員コード|カード残高|ポイントカード|保有ポイント|獲得ポイント|今回ポイント|利用ポイント|累計ポイント|残ポイント|PIN|バーコード|JAN|PLU|品番|商品(?:番号|コード)|伝票(?:番号)?|レジ(?:番号|No|NO|ID|担当|係|#|\d)|店舗(?:番号|コード)?|担当(?:者)?|レシート|領収|登録番号|インボイス|電話|TEL|FAX|住所|〒|お問合せ|お買い上げ点数|品目数|合計点数|取引番号|受付番号|No\.?\s*\d{3,}|https?:\/\/|www\.)/i;
const OCR_SUMMARY_PREFIX=/^(?:総合計|合計|税込合計|税抜合計|税別合計|本体合計|小計|税込小計|税抜小計|税別小計|お買上合計|お買い上げ合計|今回お買上合計|お支払|お支払い|ご請求|お会計|請求金額|税込金額|商品合計|商品小計|単価合計|支払金額|購入金額|商品点数|消費税|消費税額|税額|税金|内消費税|外消費税|内税|外税|課税|非課税|軽減税率|標準税率|税率|税抜|税別|税込|本体価格計|対象額|税込対象|税抜対象|8%対象|10%対象|8%税|10%税|8%内税|10%内税|8%外税|10%外税|クーポン|値引|割引|お値引|端数調整|現金|クレジット|カード支払|クレジットカード|電子マネー|お預り|お預かり|お釣り|おつり|釣銭|返金|両替|チャージ|残高|ポイント利用|ポイント値引|ポイント充当|QR決済|決済金額|売上合計)/i;
function ocrLine(s){return String(s??'').normalize('NFKC').replace(/[\t\u3000]+/g,' ').replace(/\s+/g,' ').trim();}
function ocrCompact(s){return ocrLine(s).replace(/\s+/g,'').replace(/^[＊*※#]+/,'');}
function ocrRedactPrivateText(raw){
  return String(raw||'').split(/\r?\n/).map(line=>{
    const compact=ocrCompact(line);
    if(/(?:ポイントカード|WAON\s*POINT|POINT\s*番号|ポイント番号|会員番号|会員コード|カード番号|カードNo|カードID|メンバー番号|顧客番号|お客様番号)/i.test(compact)){
      return line.replace(/[0-9０-９*＊][0-9０-９*＊\s\-ー]{4,}/g,'[番号非表示]');
    }
    if(/^[\s\d０-９-]{12,}$/.test(line))return'[長い番号を非表示]';
    return line;
  }).join('\n');
}
function ocrMoney(s){const t=String(s??'').replace(/[￥¥円,，\s]/g,'');return /^(?:\d{1,9})(?:\.\d{1,2})?$/.test(t)?Number(t):NaN;}
function ocrLastMoney(raw){const s=ocrLine(raw).replace(/[)）]\s*$/,'').trim(),m=s.match(OCR_PRICE_END);return m?ocrMoney(m[1]):null;}
function ocrIsSummaryStart(raw){
  const s=ocrCompact(raw).replace(/^[\(（]+/, '');
  return /^(?:小計|商品小計|商品合計|税抜小計|税込小計|税別小計|本体合計|総合計|お買上合計|合計)(?:$|[\d￥¥円(（:：])/i.test(s);
}
function ocrIsReceiptMetadata(raw){
  const t=ocrLine(raw),s=ocrCompact(raw);
  // Reject label+numbers on the SAME OCR line, not just label-only prefixes.
  if(/(?:レジ\s*(?:No|番号|#|:)|店\s*[:：]\s*\d|店番号|店舗番号|登録番号|インボイス|領収証|\bT\d{13}\b|レシート\s*No)/i.test(t))return true;
  if(/(?:WAON|nanaco|WAONPOINT|POINT番号|ポイント番号|ポイントカード|会員番号|カード番号|お客様番号|顧客番号|獲得ポイント|累計ポイント|残高|ポイント対象額|今回ポイント|通常ポイント|利用ポイント)/i.test(s))return true;
  if(/(?:^|\s)(?:0\d{1,4}[-ー－]\d{1,4}[-ー－]\d{3,4})(?:$|\s)/.test(t))return true;
  if(/(?:\d{1,5}\s*(?:点|品|個)\s*[￥¥]?\s*[\d,]+\s*(?:円)?$)/.test(s)&&!/[×xX*]/.test(s))return true;
  if(/^\d{8,}[A-Z]?$/i.test(s))return true;
  if(/[〇0-9*＊]{3,}\d{4,}$/.test(s)&&/(?:番号|NO|POINT)/i.test(s))return true;
  return false;
}
function ocrNonItem(raw){
  const s=ocrCompact(raw),t=ocrLine(raw);
  if(!s||ocrIsReceiptMetadata(raw)||OCR_META_PREFIX.test(s)||OCR_SUMMARY_PREFIX.test(s))return true;
  if(/^(?:[%％]?\d{1,2}[%％]?対象|[\d.,￥¥円\s*※-]+)$/.test(s))return true;
  if(/(?:消費税|内税|外税|税額|税率|小計|合計|お預|お釣|お支払|クレジット|ポイント|クーポン|値引|割引|残高|請求金額|課税|対象額|対象商品|カード番号|会員番号|カードNo|会員No|取引No|精算|登録番号|インボイス)/i.test(s))return true;
  if(/^(?:20\d{2}[/.年-]|\d{1,2}:\d{2}(?::\d{2})?$)/.test(s)||/(?:\d{1,2}月\d{1,2}日|年\d{1,2}月\d{1,2}日|(?:月|火|水|木|金|土|日)[)）]\d{1,2}[:：])/i.test(s)||/^(?:年)?\d{1,2}月\d{1,2}日/.test(s))return true;
  if(/^(?:\d[\d :\/-]{7,}|\d{8,}|\d{2,4}[-/]\d{1,2}[-/]\d{1,2})$/.test(s))return true;
  if(/^https?:|^www\.|^\(?\d{2,4}\)?[- ]\d{2,4}[- ]\d{3,4}$/i.test(s))return true;
  return false;
}
function ocrValidName(raw){
  const name=ocrLine(raw).replace(/^[＊*※\s]+/,'');
  if(!name||ocrNonItem(name)||name.length>110)return false;
  if(!/[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name))return false;
  if(name.length<2&&!/^[米卵塩酒茶]$/.test(name))return false;
  // Card numbers / long product codes by themselves are not products.
  if(/^\d{7,}(?:$|\s)/.test(name))return false;
  return true;
}
function ocrTaxKind(raw){
  const s=ocrCompact(raw);
  if(/(?:税抜|税別|税抜価格|本体価格|外税|外消費税)/.test(s))return'exclusive';
  if(/(?:税込|内税|内消費税|うち消費税)/.test(s))return'inclusive';
  return'unknown';
}
function ocrItemRate(raw){
  const s=ocrLine(raw);
  if(/(?:8\s*[%％]|軽減税率)/.test(s))return 8;
  if(/10\s*[%％]/.test(s))return 10;
  return null;
}
function ocrCleanName(raw){return ocrLine(raw).replace(/^(?:\d{3}\s+)(?=[^\d])/,'').trim();}
function ocrCandidate(raw){
  const original=ocrLine(raw);
  // Some stores print tax status AFTER a line price, e.g. "豆腐 100 (税抜)".
  // Strip ONLY the trailing tax annotation before rejecting non-items, otherwise
  // a perfectly valid product would be mistaken for a tax summary row.
  const trailingTax=original.match(/\s*(?:[（(]?\s*(?:税抜|税別|税込|内税|外税|8\s*[%％]|10\s*[%％])\s*[）)]?)\s*$/);
  const s=trailingTax?original.slice(0,-trailingTax[0].length).trim():original;
  if(ocrNonItem(s))return null;
  const m=s.match(OCR_PRICE_END);
  if(!m||m.index===0)return null;
  const label=s.slice(0,m.index).trim();
  if(ocrIsReceiptMetadata(label)||/(?:\d{1,2}月\d{1,2}日|年\d{1,2}月\d{1,2}日|\d{1,2}[:：]\d{1,2})/.test(label))return null;
  const amount=ocrMoney(m[1]);
  if(!Number.isFinite(amount)||amount<=0||amount>999999)return null;
  const taxKind=ocrTaxKind(original),rate=ocrItemRate(original);
  let name=label.replace(/(?:\s*\(?\s*(?:税抜|税別|税込|内税|外税|8\s*[%％]|10\s*[%％]|軽減税率)\s*\)?\s*)+$/g,'').trim();
  name=name.replace(/\s*(?:(?:\d+\s*(?:点|個|コ|袋|本)\s*[×xX*]\s*\d+(?:\.\d+)?)|(?:[×xX]\s*\d+))\s*$/,'').trim();
  name=name.replace(/^(?:\d{8,14}\s+)/,'').replace(/^(?:\d{3}\s+)(?=[^\d])/,'').replace(/^[＊*※\s]+/,'').trim();
  name=ocrCleanName(name);
  if(!ocrValidName(name))return null;
  return{name,amount,rawAmount:amount,rawLine:s,taxKind,taxRate:rate,taxMark:/^[※＊*]|[※＊*]\s*$/.test(s),qty:1,unit:'個'};
}
// Parse price-per-piece annotations attached to the preceding purchased line.
// 625 キャベツガリバタ 447※ / (@149 × 3(個)) => one line, qty 3, total 447.
function ocrQuantityNote(raw,expectedAmount){
  const s=ocrLine(raw).replace(/[（）]/g,c=>c==='（'?'(':')');
  if(!/^\(?\s*(?:@|＠|\d+\s*[￥¥円]?\s*[×xX*])/i.test(s))return null;
  const m=s.match(/(?:[@＠]\s*[￥¥]?\s*(\d[\d,]*)\s*[円]?)\s*[×xX*]\s*(\d{1,3})(?:\s*\(?\s*(個|点|本|袋|枚|パック)\s*\)?)?/i)
       ||s.match(/(?:\d{1,3}\s*[×xX*]\s*[￥¥]?\s*\d[\d,]*)/i);
  if(!m||!m[1]||!m[2])return null;
  const unitPrice=ocrMoney(m[1]),qty=Number(m[2]);
  if(!Number.isInteger(qty)||qty<2||qty>100||!Number.isFinite(unitPrice))return null;
  if(Math.abs(unitPrice*qty-expectedAmount)>.01)return{qty:null,mismatch:true,price:unitPrice};
  return{qty,unit:m[3]||'個',price:unitPrice};
}
// Discounts belong to the preceding merchandise line. A store may omit
// the minus sign in the OCR result, but an explicit discount label still means
// subtracting from the product. Never invent a discount from an unlabeled price.
function ocrDiscountLine(raw,nextRaw=''){
  const text=ocrLine(raw);
  const normalized=ocrCompact(text).replace(/^[★☆●◆・\s]+/,'');
  if(!/(?:自動割引|特売値引|商品値引|お値引|値引|割引|クーポン値引|タイムサービス値引)/.test(normalized))return null;
  // Payment/point settlement adjustments are not merchandise discounts.
  if(/ポイント|支払|合計|小計|精算/.test(normalized))return null;
  let signed=normalized.match(/[-−－ー]\s*[￥¥]?\s*(\d[\d,]*)\s*(?:円)?\s*[※＊*]?$/);
  let value=signed?ocrMoney(signed[1]):null;
  let explicitMinus=!!signed;
  if(value===null){
    const m=normalized.match(/(?:値引|割引)[^\n]*?[）)]?\s*[￥¥]?\s*(\d[\d,]*)\s*(?:円)?\s*[※＊*]?$/);
    if(m)value=ocrMoney(m[1]);
  }
  let takesNext=false;
  if((value===null||!Number.isFinite(value))&&nextRaw){
    const n=ocrLine(nextRaw);
    const m=n.match(/^\s*[-−－]?\s*[￥¥]?\s*(\d[\d,]*)\s*円?\s*$/);
    if(m){value=ocrMoney(m[1]);takesNext=true;explicitMinus=/[-−－]/.test(n);}
  }
  if(!Number.isSafeInteger(value)||value<=0||value>999999)return null;
  return{value,takesNext,explicitMinus,label:text};
}
function ocrParseItemLines(lines){
  const input=lines.map(x=>ocrLine(typeof x==='string'?x:x?.text)).filter(Boolean);
  const items=[],ignored=[],notes=[],discounts=[];
  let summaryStarted=false;
  for(let i=0;i<input.length;i++){
    const s=input[i];
    if(ocrIsSummaryStart(s)||/^\d{1,3}\s*(?:点|品)\s*[￥¥]?\s*[\d,]+\s*(?:円)?$/.test(ocrCompact(s)))summaryStarted=true;
    if(summaryStarted){ignored.push(s);continue;}
    const discount=ocrDiscountLine(s,input[i+1]);
    if(discount){
      ignored.push(s);
      if(discount.takesNext){ignored.push(input[i+1]);i++;}
      const previous=items.at(-1);
      if(previous&&discount.value<=previous.rawAmount){
        previous.discount=(previous.discount||0)+discount.value;
        previous.rawAmount-=discount.value;
        previous.amount=previous.rawAmount;
        previous.discountLines=[...(previous.discountLines||[]),discount.label];
        discounts.push({name:previous.name,amount:discount.value,line:discount.label,applied:true});
      }else{
        discounts.push({name:'未対応',amount:discount.value,line:discount.label,applied:false});
        notes.push('値引き '+discount.value+'円を対象商品に紐づけられません。写真を確認してください。');
      }
      continue;
    }
    if(ocrNonItem(s)){ignored.push(s);continue;}
    let item=ocrCandidate(s);
    if(!item&&ocrValidName(s)&&i+1<input.length){
      const next=input[i+1];const m=next.match(OCR_ONLY_PRICE);
      if(m){const amount=ocrMoney(m[1]);if(Number.isFinite(amount)&&amount>0&&amount<=999999){
        item={name:ocrCleanName(s),amount,rawAmount:amount,rawLine:s+' / '+next,taxKind:ocrTaxKind(s),taxRate:ocrItemRate(s),taxMark:/^[※＊*]|[※＊*]\s*$/.test(next),qty:1,unit:'個'};i++;
      }}else if(i+2<input.length&&/^(?:\d+\s*(?:点|個)|[×xX*]\s*\d+|\d+\s*[×xX*]\s*\d+)$/i.test(next)){
        const price=input[i+2].match(OCR_ONLY_PRICE);
        if(price){const amount=ocrMoney(price[1]);if(Number.isFinite(amount)&&amount>0&&amount<=999999){
          item={name:ocrCleanName(s),amount,rawAmount:amount,rawLine:s+' / '+next+' / '+input[i+2],taxKind:ocrTaxKind(s),taxRate:ocrItemRate(s),taxMark:/^[※＊*]|[※＊*]\s*$/.test(input[i+2]),qty:1,unit:'個'};i+=2;
        }}
      }
    }
    if(item){
      if(i+1<input.length){
        const note=ocrQuantityNote(input[i+1],item.rawAmount);
        if(note){
          if(note.qty){item.qty=note.qty;item.unit=note.unit;item.perUnitPrice=note.price;}
          else if(note.mismatch)notes.push('数量行の掛け算と商品金額が一致しません：'+input[i+1]);
          ignored.push(input[i+1]);i++;
        }
      }
      items.push(item);
    }else ignored.push(s);
  }
  return{items:items.slice(0,100),ignored,notes,discounts};
}
function ocrFindDate(lines){
  const s=lines.join(' ');
  const m=s.match(/(20\d{2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})日?/);
  if(!m)return null;
  const y=Number(m[1]),mon=Number(m[2]),day=Number(m[3]),d=new Date(Date.UTC(y,mon-1,day));
  if(d.getUTCFullYear()!==y||d.getUTCMonth()!==mon-1||d.getUTCDate()!==day)return null;
  return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
}
function ocrSummaryLabel(raw){return ocrCompact(raw).replace(/^[￥¥]/,'');}
// A till receipt has three different money concepts: actual purchase total,
// cash tendered, and change. A payment/tender number is never evidence of price.
function ocrCashEvidence(lines){
  const out={tender:null,change:null,payment:null};
  for(let i=0;i<lines.length;i++){
    const compact=ocrSummaryLabel(lines[i]).replace(/^[（(]/,'');
    let type=null;
    if(/^(?:お預り|お預かり|預り|預かり|お預|現金お預り)/.test(compact))type='tender';
    else if(/^(?:お釣り|おつり|お釣|釣銭|お返し|つり銭)/.test(compact))type='change';
    else if(/^(?:お支払|お支払い|支払金額)/.test(compact))type='payment';
    if(!type)continue;
    const value=ocrNearbyMoney(lines,i);
    if(value!=null&&Number.isFinite(value)&&value>=0)out[type]=value;
  }
  return out;
}
function ocrPrintedNetAndTax(lines){
  const subtotals=ocrFindSubtotals(lines);
  const net=subtotals.find(x=>/^(?:小計|税抜小計|税別小計|本体価格計|商品小計)/.test(x.compact))||
    subtotals.find(x=>/^(?:8|10)[%％](?:外税|税抜)?対象額/.test(x.compact));
  const taxes=ocrFindTaxes(lines),tax=taxes.length?taxes.reduce((sum,t)=>sum+t.amount,0):null;
  // This inference needs a separately labeled NET subtotal AND separately labeled tax.
  return net&&tax!=null&&tax>=0?{total:net.amount+tax,net:net.amount,tax}:null;
}
function ocrFindTotal(lines){
  const candidates=[];
  for(let i=0;i<lines.length;i++){
    const s=ocrSummaryLabel(lines[i]);
    if(/(?:小計|税抜|税別|本体|対象額|税額|内税|外税|税率|合計点数|売上合計|お預|お釣|釣銭|ポイント)/.test(s))continue;
    let score=0;
    if(/^(?:総合計|税込合計|合計|お買上合計|お買い上げ合計|今回お買上合計)/.test(s))score=100;
    else if(/^(?:ご請求|請求金額|お会計|購入金額)/.test(s))score=85;
    else if(/^(?:お支払|お支払い|支払金額)/.test(s))score=50;
    else continue;
    let amount=ocrLastMoney(lines[i]);
    if((amount===null||!Number.isFinite(amount))&&lines[i+1]&&OCR_ONLY_PRICE.test(ocrLine(lines[i+1])))amount=ocrMoney(ocrLine(lines[i+1]).match(OCR_ONLY_PRICE)[1]);
    if(amount!==null&&Number.isFinite(amount)&&amount>0&&amount<10000000)candidates.push({amount,score,index:i,line:lines[i]});
  }
  const cash=ocrCashEvidence(lines),netTax=ocrPrintedNetAndTax(lines);
  const expectedFromCash=cash.tender!=null&&cash.change!=null&&cash.tender>=cash.change?cash.tender-cash.change:null;
  candidates.sort((a,b)=>b.score-a.score||b.index-a.index);
  const verified=candidates.find(c=>netTax&&Math.abs(c.amount-netTax.total)<=1)||
    candidates.find(c=>expectedFromCash!=null&&Math.abs(c.amount-expectedFromCash)<=1);
  if(verified)return{amount:verified.amount,source:verified.line,candidates,cash,netTax,verified:true};
  const best=candidates[0];
  if(!best)return{amount:null,source:'',candidates,cash,netTax,verified:false};
  const looksLikeTender=(cash.tender!=null&&Math.abs(best.amount-cash.tender)<=1)||
    (cash.change!=null&&netTax!=null&&Math.abs(best.amount-cash.change-netTax.total)<=1);
  // When the alleged grand total contradicts the *separately printed* subtotal
  // plus tax, prefer an explicit 'unreadable' status over the wrong cash tender.
  if(looksLikeTender||(best.score<95&&netTax&&Math.abs(best.amount-netTax.total)>1))
    return{amount:null,source:'合計候補が税抜小計・税額またはお預りと矛盾',candidates,cash,netTax,verified:false,rejected:best};
  // 'お支払' can also mean tendered cash: never accept without other evidence.
  if(best.score<80)return{amount:null,source:'支払額のため購入合計は未確定',candidates,cash,netTax,verified:false,rejected:best};
  return{amount:best.amount,source:best.line,candidates,cash,netTax,verified:false};
}
function ocrNearbyMoney(lines,index){
  const onLine=ocrLastMoney(lines[index]);
  if(Number.isFinite(onLine))return onLine;
  for(let j=index+1;j<=Math.min(lines.length-1,index+3);j++){
    const s=ocrLine(lines[j]);
    if(ocrIsSummaryStart(s)||/^(?:8|10)\s*[%％].*(?:税額|対象)|^お?預|^お?釣|^ポイント/i.test(ocrCompact(s)))break;
    if(OCR_ONLY_PRICE.test(s))return ocrMoney(s.match(OCR_ONLY_PRICE)[1]);
    if(/^(?:\d+\s*(?:点|品|個))$/.test(s))continue;
    const rowCountAndAmount=s.match(/^\d{1,3}\s*(?:点|品)\s*[￥¥]?\s*([\d,]+)\s*円?$/);
    if(rowCountAndAmount)return ocrMoney(rowCountAndAmount[1]);
    break;
  }
  return null;
}
function ocrFindSubtotals(lines){
  const out=[];
  for(let i=0;i<lines.length;i++){
    const s=ocrSummaryLabel(lines[i]).replace(/^[（(]/,'');
    if(!/^(?:税抜小計|税別小計|税込小計|本体価格計|小計|商品小計|商品合計|税抜合計|本体合計|税別合計|\d{1,2}[%％](?:外税|内税|税抜|税込)?対象額)/.test(s))continue;
    let amount=ocrNearbyMoney(lines,i);
    if(!Number.isFinite(amount)){
      const nearby=ocrCompact(lines[i+1]||'').match(/^\d{1,3}(?:点|品)[￥¥]?([\d,]+)円?$/);
      if(nearby)amount=ocrMoney(nearby[1]);
    }
    if(Number.isFinite(amount))out.push({line:ocrLine(lines[i]),compact:s,index:i,amount});
  }
  return out;
}
function ocrFindTaxes(lines){
  const result=[];
  for(let i=0;i<lines.length;i++){
    const raw=lines[i],s=ocrSummaryLabel(raw).replace(/^[（(]/,'');
    if(/対象額|対象商品|課税対象|非課税対象/.test(s)&&!/税額|消費税/.test(s))continue;
    if(!/(?:消費税|税額|内税|外税)/.test(s))continue;
    if(/^(?:商品|小計|合計)/.test(s))continue;
    const amount=ocrNearbyMoney(lines,i);
    if(!Number.isFinite(amount)||amount<0||amount>999999)continue;
    const rate=(s.match(/(?:^|[^0-9])(8|10)\s*[%％]/)||[])[1];
    const general=/^(?:消費税合計|消費税額合計|税額合計|合計税額|うち消費税|内消費税合計)/.test(s);
    result.push({rate:rate?Number(rate):null,amount,kind:ocrTaxKind(s),general,line:ocrLine(raw)});
  }
  const specific=result.filter(x=>x.rate!==null);
  if(specific.length){
    const unique=new Map();for(const v of specific)unique.set(v.rate,v);
    return[...unique.values()];
  }
  return result.length?[result.at(-1)]:[];
}
function ocrFindItemCount(lines){
  // Maruetsu format: 小計 / 11点 1,600. Accept amount on the same row as count.
  for(let i=0;i<lines.length;i++){
    const s=ocrCompact(lines[i]);
    if(!/^(?:小計|商品小計|商品合計|合計)/.test(s))continue;
    for(let j=i;j<=Math.min(i+3,lines.length-1);j++){
      const t=ocrCompact(lines[j]);
      const m=t.match(/(?:^|[^0-9])(\d{1,3})\s*(?:点|品)(?=$|[^\p{L}])/u);
      if(m)return Number(m[1]);
      if(j>i&&/^(?:税込|税抜|外税|内税|消費税|8%|10%|合計)/.test(t))break;
    }
  }
  return null;
}
function ocrFindDiscounts(lines){
  return lines.filter(x=>/^(?:.+\s)?(?:値引|割引|クーポン|お値引|端数調整)/.test(ocrCompact(x))||/^(?:ポイント利用|ポイント値引|ポイント充当)/.test(ocrCompact(x))).slice(0,12);
}
function ocrMerchant(lines){
  return lines.slice(0,8).map(ocrLine).find(s=>s.length>=2&&s.length<=70&&
    !ocrNonItem(s)&&!ocrCandidate(s)&&!/[￥¥]\s*\d+/.test(s)&&
    !/^(?:[\d\-\/. :年月日時分秒]+|ありがとう|いらっしゃい)/.test(s))||'購入先未設定';
}
// v1.6: receipt-wide tax evidence. A printed tax legend is an instruction,
// not a purchased product. Normalization also accepts OCR-inserted spaces.
function ocrTaxLegend(lines){
  const all=lines.map(x=>ocrLine(x)).join(' ');
  const tight=all.replace(/[\s\u3000]/g,'');
  const direct=/(?:※|＊|\*)印(?:は|が|:|：)?(?:軽減税率|8[%％])|(?:※|＊|\*)[^。]{0,22}軽減税率|軽減税率[^。]{0,22}(?:※|＊|\*)/i.test(tight);
  return {reducedMark:direct,text:direct?'※印は軽減税率対象を示す（レシート注記）':''};
}
function ocrRateEvidence(item,legend,rateBuckets){
  if(item.taxRate===8||item.taxRate===10)return{rate:item.taxRate,certain:true,reason:'商品行に'+item.taxRate+'%の記載'};
  if(legend.reducedMark&&item.taxMark)return{rate:8,certain:true,reason:'※印＋軽減税率の注記'};
  // When * denotes 8%, unmarked lines are NOT assumed 10% without tax-group evidence.
  if(legend.reducedMark&&!item.taxMark&&rateBuckets?.has(8)&&rateBuckets?.has(10))
    return {rate:10,certain:true,reason:'※印なし＋8%/10%双方の税区分'};
  if(rateBuckets?.size===1&&rateBuckets.has(8))
    return {rate:8,certain:false,reason:'8%の税額記載（商品別は未確定）'};
  if(rateBuckets?.size===1&&rateBuckets.has(10))
    return {rate:10,certain:false,reason:'10%の税額記載（商品別は未確定）'};
  const hint=ocrRateHint(item);
  return{rate:hint.rate,certain:false,reason:'商品名などからの参考推定'};
}
function ocrRateHint(item){
  if(item.taxRate===8||item.taxRate===10)return{rate:item.taxRate,reliable:true};
  if(item.taxMark&&item.hasReducedMarkLegend)return{rate:8,reliable:true};
  const s=item.name;
  if(/(?:ビール|チューハイ|ワイン|日本酒|焼酎|酒類|シャンプー|洗剤|歯ブラシ|ティッシュ|トイレット|化粧|乾電池|電池|文具)/i.test(s))return{rate:10,reliable:false};
  return{rate:8,reliable:false};
}
function ocrTaxShares(weights,total){
  if(!weights.length)return[];
  const denominator=weights.reduce((s,v)=>s+v,0);
  if(denominator<=0)return weights.map(()=>0);
  const raw=weights.map(w=>total*w/denominator);
  const allocation=raw.map(Math.floor);
  const fractions=raw.map((v,i)=>({i,frac:v-allocation[i]})).sort((a,b)=>b.frac-a.frac||a.i-b.i);
  const outstanding=total-allocation.reduce((a,b)=>a+b,0);
  for(let i=0;i<outstanding;i++)allocation[fractions[i%fractions.length].i]++;
  return allocation;
}
function ocrTaxDistribution(items,totalTax,taxes,legend){
  const output=items.map(()=>0),taxBuckets=new Map(taxes.filter(t=>t.rate===8||t.rate===10).map(t=>[t.rate,t.amount]));
  const evidenced=items.map(item=>ocrRateEvidence(item,legend,taxBuckets));
  const exclusive=items.map((item,i)=>item.taxKind==='inclusive'?-1:i).filter(x=>x>=0);
  const eligible=exclusive.filter(i=>items[i].rawAmount>0);
  if(!eligible.length)return{distribution:output,evidenced,confirmed:false,reason:'すべて税込表示のため税額の加算対象がありません'};
  const groupedTax=taxBuckets.size>0&&[...taxBuckets.values()].reduce((s,v)=>s+v,0)===totalTax;
  let groupSupported=false;
  if(groupedTax){
    // Tax subtotals prove how much belongs to each rate; allocate only within matched categories.
    const chosen=eligible.map(i=>evidenced[i].rate);
    const complete=[...taxBuckets.keys()].every(rate=>chosen.includes(rate))&&chosen.every(rate=>taxBuckets.has(rate));
    if(complete){
      for(const[rate,amount]of taxBuckets){
        const indices=eligible.filter(i=>evidenced[i].rate===rate);
        const shares=ocrTaxShares(indices.map(i=>items[i].rawAmount),amount);
        indices.forEach((i,j)=>{output[i]=shares[j]});
      }
      groupSupported=true;
    }
  }
  if(!groupSupported){
    // If a rate split is ambiguous, honor the printed total tax but flag every uncertain line.
    const weights=eligible.map(i=>items[i].rawAmount*evidenced[i].rate);
    const shares=ocrTaxShares(weights,totalTax);
    eligible.forEach((i,j)=>{output[i]=shares[j]});
  }
  const confirmed=evidenced.every((e,i)=>items[i].taxKind==='inclusive'||e.certain)&&(!taxBuckets.size||groupSupported);
  return{distribution:output,evidenced,confirmed,reason:groupSupported?'レシートの税率別税額を使用':'印字税額を、推定した税率と商品金額により配分'};
}
// Recognize tax amounts even when the OCR splits "8%対象税額" and "¥128"
// across two lines. ocrFindTaxes remains the authoritative source for amounts.
function ocrTaxAudit(lines){
  const tax=ocrFindTaxes(lines),subtotals=ocrFindSubtotals(lines),legend=ocrTaxLegend(lines);
  const subtotalNet=subtotals.filter(s=>!/(?:税込|内税)/.test(s.compact));
  const taxTotal=tax.length?tax.reduce((s,v)=>s+v.amount,0):null;
  return{tax,subtotals,subtotalNet,legend,taxTotal};
}
function ocrReconcile(items,allLines,totalInfo,appliedDiscounts=[]){
  const evidence=ocrTaxAudit(allLines);
  const{tax,subtotals,legend,taxTotal}=evidence;
  items.forEach(i=>{i.hasReducedMarkLegend=legend.reducedMark;});
  const printedCount=ocrFindItemCount(allLines);
  const parsedCount=items.reduce((s,i)=>s+(i.qty||1),0);
  const rawSum=items.reduce((s,i)=>s+Number(i.rawAmount||0),0);
  const subtotalMatch=subtotals.some(x=>Math.abs(x.amount-rawSum)<=1);
  const printedTotal=totalInfo.amount;
  const discounts=ocrFindDiscounts(allLines);
  const discountSum=appliedDiscounts.filter(d=>d.applied).reduce((v,d)=>v+d.amount,0);
  const unresolvedDiscounts=appliedDiscounts.filter(d=>!d.applied);
  const allMarked=legend.reducedMark&&items.length>0&&items.every(i=>i.taxMark||i.taxRate===8);
  const explicitNet=items.some(i=>i.taxKind==='exclusive')||subtotals.some(i=>/税抜|税別|本体/.test(i.compact))||tax.some(i=>i.kind==='exclusive');
  const explicitGross=items.some(i=>i.taxKind==='inclusive')||subtotals.some(i=>/税込/.test(i.compact))||tax.some(i=>i.kind==='inclusive');
  const markInfo=items.filter(i=>i.taxMark).length;
  const r={mode:'unknown',status:'review',printedTotal,derivedTotal:null,effectiveTotal:printedTotal,totalSource:printedTotal!=null?'印字合計':'不明',subtotal:subtotals.find(x=>Math.abs(x.amount-rawSum)<=1)?.amount??subtotals.at(-1)?.amount??null,
    rawSum,itemSum:rawSum,observedTax:taxTotal,allocatedTax:0,difference:printedTotal==null?null:printedTotal-rawSum,
    hasDiscounts:discounts.length>0,discountLines:discounts,discountSum,discountApplications:appliedDiscounts,explanations:[],taxLines:tax.map(x=>x.line),taxLegend:legend.text,
    markedItems:markInfo,rateBreakdown:[],ignoredCount:0,printedCount,parsedCount};
  const warn=x=>{if(!r.explanations.includes(x))r.explanations.push(x)};
  if(totalInfo.rejected)warn('OCRの「'+totalInfo.rejected.amount+'円」は預り金・支払金の可能性があり、印字合計として採用しませんでした。');
  if(!items.length){warn('商品明細を抽出できませんでした。写真を確認してください。');return r;}
  if(legend.reducedMark)warn('※印は軽減税率対象という注記を検出しました。対象の商品行には8%を使用します。');
  if(discountSum)warn('商品直下の値引き '+discountSum+'円を商品の税抜額から控除しました。');
  // If OCR could not recover the printed total, a validated net subtotal + printed
  // tax can be used as a PROVISIONAL effective total; never call it printed.
  if(printedTotal==null&&taxTotal!==null&&!explicitGross&&unresolvedDiscounts.length===0&&
    (subtotalMatch||subtotals.some(s=>/^(?:小計|商品小計|税抜小計|税別小計|本体価格計)/.test(s.compact)))){
    // Show provisional *receipt* total even if OCR missed one item.
    // Do not change item prices or pretend the receipt has reconciled.
    const printedNet=subtotals.find(s=>/^(?:小計|商品小計|税抜小計|税別小計|本体価格計)/.test(s.compact));
    const basis=subtotalMatch?rawSum:printedNet.amount;
    r.derivedTotal=basis+taxTotal;r.effectiveTotal=r.derivedTotal;
    r.totalSource=subtotalMatch?'税抜小計＋印字税額から計算（印字合計未検出）':'印字小計＋税額から参考計算（商品明細に不足あり）';
    warn('合計の印字はOCRで検出できませんでした。小計と印字税額から参考額を計算しました。写真で合計を確認してください。');
    if(!subtotalMatch)warn('商品が読み落とされているため、この参考額に合わせて明細を自動補完しません。');
  }else if(printedTotal==null&&subtotalMatch&&allMarked&&!explicitGross&&unresolvedDiscounts.length===0){
    const estimate=Math.floor(rawSum*.08);
    if(estimate>0){r.derivedTotal=rawSum+estimate;r.effectiveTotal=r.derivedTotal;r.totalSource='※印と8%から参考計算（印字税額・合計未検出）';
      warn('税額・合計の印字を検出できなかったため、※印に基づき8%を参考計算しました。写真で税額を確認してください。');}
  }
  const target=r.effectiveTotal;
  const rawDiff=target==null?null:target-rawSum;
  const taxProof=taxTotal!=null&&rawDiff!=null&&Math.abs(taxTotal-rawDiff)<=1;
  const markProof=allMarked&&rawDiff!=null&&Math.abs(rawDiff-Math.floor(rawSum*.08))<=1;
  const taxLike=rawDiff!=null&&rawSum>0&&rawDiff/rawSum>=.065&&rawDiff/rawSum<=.115;
  const subtotalProof=subtotalMatch||explicitNet;
  // Inclusive receipt: NEVER add the same printed tax again.
  if(target!=null&&Math.abs(rawDiff)<=1){
    r.mode='inclusive';r.status=printedTotal!=null&&Math.abs(rawDiff)<.01&&!explicitNet?'match':'review';
    if(explicitNet)warn('明細と税込合計がすでに一致していますが、税抜を示す記載もあります。二重課税を避けました。');
    else warn('商品金額は印字合計と一致しています。税を二重加算しません。');
    if(Math.abs(rawDiff)>.01)warn('1円の差があります。端数処理を確認してください。');
  }else if(target!=null&&rawDiff>0&&!explicitGross&&unresolvedDiscounts.length===0&&
    ((taxProof&&(subtotalProof||markProof))||(markProof&&subtotalProof)||((explicitNet||subtotalMatch)&&taxLike))){
    r.mode=printedTotal==null?'exclusive-estimated':'exclusive';
    const split=ocrTaxDistribution(items,rawDiff,tax,legend);
    for(let i=0;i<items.length;i++){
      items[i].taxAdded=split.distribution[i];items[i].amount=items[i].rawAmount+split.distribution[i];
      items[i].taxRateResolved=split.evidenced[i].rate;
      items[i].taxRateSource=split.evidenced[i].reason;
      items[i].taxRateConfirmed=split.evidenced[i].certain;
    }
    r.allocatedTax=rawDiff;r.itemSum=items.reduce((s,i)=>s+i.amount,0);
    r.difference=target-r.itemSum;r.rateBreakdown=[...new Map(split.evidenced.map(x=>[x.rate,x])).values()].map(x=>({rate:x.rate,reason:x.reason}));
    // A definitive match requires printed total, exact printed tax, matching subtotal,
    // complete counts (when printed) and product-rate evidence.
    const countConfirmed=printedCount==null||printedCount===parsedCount;
    r.status=printedTotal!=null&&taxProof&&subtotalMatch&&countConfirmed&&split.confirmed&&Math.abs(r.difference)<.01?'match':'review';
    warn(`税抜明細${rawSum}円に消費税${rawDiff}円を自動配分し、税込${r.itemSum}円に換算しました。`);
    warn('税率の根拠：'+split.reason+'。');
    if(!taxProof)warn('印字税額との一致を確認できません。税込配分は暫定値です。');
    if(!split.confirmed)warn('商品ごとの税率が確定できないため、配分は参考値です。写真を確認してください。');
  }else if(target!=null&&rawDiff<0){
    r.mode='unreconciled';warn('明細合計がレシート合計より大きいです。重複・値引き・OCR誤りを確認してください。');
  }else if(target!=null){
    r.mode='unreconciled';warn('税額・値引き・商品行を根拠なく補正しません。税込合計との差を確認してください。');
  }else if(explicitNet&&!explicitGross){
    // Only when the receipt explicitly marks exclusive prices; do not silently
    // fabricate "printed" tax or receipt totals.
    r.mode='exclusive-estimated';
    const hints=items.map(i=>ocrRateEvidence(i,legend,new Map()));
    const grouped=new Map();
    for(let i=0;i<items.length;i++){
      if(items[i].taxKind==='inclusive')continue;
      const rate=hints[i].rate,indices=grouped.get(rate)||[];indices.push(i);grouped.set(rate,indices);
    }
    let estimate=0;const added=items.map(()=>0);
    for(const [rate,indices] of grouped){
      const subtotal=indices.reduce((v,i)=>v+items[i].rawAmount,0);
      const groupTax=Math.floor(subtotal*rate/100);
      const shares=ocrTaxShares(indices.map(i=>items[i].rawAmount),groupTax);
      indices.forEach((i,k)=>added[i]=shares[k]);estimate+=groupTax;
    }
    items.forEach((i,k)=>{i.taxAdded=added[k];i.amount=i.rawAmount+added[k];
      i.taxRateResolved=hints[k].rate;i.taxRateSource=hints[k].reason;i.taxRateConfirmed=hints[k].certain;});
    r.allocatedTax=estimate;r.itemSum=rawSum+estimate;
    warn('税抜を示す記載がありますが、印字合計が確認できません。推定税率で参考税込額を計算したため、写真で確認してください。');
  }else warn('税込・税抜を確定できず、自動で税を加算しませんでした。写真で確認してください。');
  if(printedCount!=null&&printedCount!==parsedCount){r.status='review';warn(`レシートは${printedCount}点、抽出結果は${parsedCount}点です。商品数量を確認してください。`);}
  if(subtotals.length&&!subtotalMatch&&!(printedTotal!=null&&Math.abs(rawSum-printedTotal)<=1)){
    r.status='review';warn('商品金額と印字小計が一致しません。読み落とし・OCR誤りを確認してください。');}
  if(unresolvedDiscounts.length||(discounts.length&&!discountSum)){r.status='review';warn('値引き・割引が未対応の可能性があります。写真と税込合計を確認してください。');}
  if(explicitNet&&explicitGross){r.status='review';warn('税込・税抜の表記が混在しています。二重課税を避けるため写真で確認してください。');}
  return r;
}
function ocrExtractReceipt(raw,layoutLines=[]){
  const textLines=String(raw||'').normalize('NFKC').replace(/[\r\u0000]/g,'').split('\n').map(ocrLine).filter(Boolean);
  const geoLines=Array.isArray(layoutLines)?layoutLines.slice(0,400).map(x=>ocrLine(typeof x==='string'?x:x?.text)).filter(Boolean):[];
  const totalInfo=ocrFindTotal(textLines.length?textLines:geoLines);
  const layoutTotal=geoLines.length?ocrFindTotal(geoLines):null;
  // If the main OCR found contradictory cash/tender, a layout candidate is accepted
  // only if independent subtotal+tax evidence does not contradict it.
  const candidateTotal=totalInfo.amount??layoutTotal?.amount??null;
  const netEvidence=totalInfo.netTax||layoutTotal?.netTax;
  const total=netEvidence&&candidateTotal!=null&&Math.abs(candidateTotal-netEvidence.total)>1?null:candidateTotal;
  const sources=[{label:'OCR文字列',lines:textLines,parsed:ocrParseItemLines(textLines)}];
  if(geoLines.length)sources.push({label:'文字の位置情報',lines:geoLines,parsed:ocrParseItemLines(geoLines)});
  const assessments=sources.map(src=>{
    const items=src.parsed.items.map(i=>({...i}));
    const srcInfo=ocrFindTotal(src.lines);
    const selectedInfo=srcInfo.amount!=null?srcInfo:totalInfo;
    const rec=ocrReconcile(items,[...textLines,...(src.label==='文字の位置情報'?geoLines:[])],{...selectedInfo,amount:total},src.parsed.discounts);
    const delta=rec.difference===null?999999:Math.abs(rec.difference);
    const exact=rec.status==='match'&&delta===0;
    // More lines alone is not quality: strong preference for complete, reconciled receipts.
    const completeCount=rec.printedCount==null?0:(rec.parsedCount===rec.printedCount?1000:-450*Math.abs(rec.printedCount-rec.parsedCount));
    const netSubtotalMatch=rec.subtotal!=null&&Math.abs(rec.subtotal-rec.rawSum)<=1?800:rec.subtotal!=null?-400:0;
    const score=(exact?10000:0)+(delta<=1?300:0)+completeCount+netSubtotalMatch+
      items.length*10-Math.min(800,delta/2)-src.parsed.ignored.length*.01;
    return{src,items,rec,score};
  });
  assessments.sort((a,b)=>b.score-a.score);
  const selected=assessments[0];
  const warnings=[...selected.src.parsed.notes];
  const rec=selected.rec;
  if(!selected.items.length)warnings.push('商品明細を抽出できませんでした。カード番号や税額・小計を商品登録せず、写真を見て入力してください');
  if(rec.status!=='match')warnings.push(...rec.explanations);
  if(rec.printedTotal!==null&&selected.items.length===1&&rec.rawSum<rec.printedTotal*.4)warnings.push('商品が1件しか検出されていません。読み落としの可能性があります');
  if(selected.items.length>=100)warnings.push('明細が100行を超えた可能性があります');
  const date=ocrFindDate(textLines)||ocrFindDate(geoLines);
  if(!date)warnings.push('購入日が判別できませんでした');
  return{merchant:ocrMerchant(textLines.length?textLines:geoLines),date,total:rec.effectiveTotal,items:selected.items,warnings,
    rawLineCount:textLines.length,parsedSource:selected.src.label,lineSum:rec.itemSum,ignoredLines:selected.src.parsed.ignored.slice(0,60),
    reconciliation:rec,discounts:selected.src.parsed.discounts};
}
