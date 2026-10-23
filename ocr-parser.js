'use strict';
// くらしのレシート v1.3: conservative Japanese receipt parsing.
// OCR text/layout -> product candidates -> tax treatment -> reconciled VAT-inclusive amounts.
// Never turn point-card IDs, subtotals, taxes, payment rows or unknown differences into products.
const OCR_PRICE_END=/(?:[￥¥]\s*)?((?:\d{1,3}(?:,\d{3})+|\d{1,8})(?:\.\d{1,2})?)\s*円?\s*[＊*※]?\s*$/;
const OCR_ONLY_PRICE=/^[＊*※]?\s*[￥¥]?\s*((?:\d{1,3}(?:,\d{3})+|\d{1,8})(?:\.\d{1,2})?)\s*円?\s*[＊*※]?\s*$/;
const OCR_META_PREFIX=/^(?:ポイント|会員|会員カード|お客様|カード(?:番号|No|NO|ID|会員)|会員番号|会員コード|カード残高|ポイントカード|保有ポイント|獲得ポイント|今回ポイント|利用ポイント|累計ポイント|残ポイント|PIN|バーコード|JAN|PLU|商品(?:番号|コード)|伝票(?:番号)?|レジ(?:番号|No|NO|ID|担当|係|#|\d)|店舗(?:番号|コード)?|担当(?:者)?|レシート|領収|登録番号|インボイス|電話|TEL|FAX|住所|〒|お問合せ|お買い上げ点数|品目数|合計点数|取引番号|受付番号|No\.?\s*\d{3,}|https?:\/\/|www\.)/i;
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
function ocrLastMoney(raw){const s=ocrLine(raw),m=s.match(OCR_PRICE_END);return m?ocrMoney(m[1]):null;}
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
  if(/^(?:20\d{2}[/.年-]|\d{1,2}:\d{2}(?::\d{2})?$)/.test(s))return true;
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
  if(ocrNonItem(original))return null;
  // Some stores print tax status AFTER a line price, e.g. "豆腐 100 (税抜)".
  const trailingTax=original.match(/\s*(?:[（(]?\s*(?:税抜|税別|税込|内税|外税|8\s*[%％]|10\s*[%％])\s*[）)]?)\s*$/);
  const s=trailingTax?original.slice(0,-trailingTax[0].length).trim():original;
  const m=s.match(OCR_PRICE_END);
  if(!m||m.index===0)return null;
  const label=s.slice(0,m.index).trim();
  if(ocrIsReceiptMetadata(label))return null;
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
function ocrParseItemLines(lines){
  const input=lines.map(x=>ocrLine(typeof x==='string'?x:x?.text)).filter(Boolean);
  const items=[],ignored=[],notes=[];
  // Strictly stop treating any later lines as merchandise once the checkout
  // summary begins. This rejects point balances, cashier IDs and payment rows.
  let summaryStarted=false;
  for(let i=0;i<input.length;i++){
    const s=input[i];
    if(ocrIsSummaryStart(s))summaryStarted=true;
    if(summaryStarted){ignored.push(s);continue;}
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
  return{items:items.slice(0,100),ignored,notes};
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
function ocrFindTotal(lines){
  const candidates=[];
  for(let i=0;i<lines.length;i++){
    const s=ocrSummaryLabel(lines[i]);
    if(/(?:小計|税抜|税別|本体|対象額|税額|内税|外税|税率|合計点数|売上合計)/.test(s))continue;
    let score=0;
    if(/^(?:総合計|税込合計|合計|お買上合計|お買い上げ合計|今回お買上合計)/.test(s))score=100;
    else if(/^(?:ご請求|請求金額|お会計|購入金額)/.test(s))score=85;
    else if(/^(?:お支払|お支払い|支払金額)/.test(s))score=65;
    else continue;
    let amount=ocrLastMoney(lines[i]);
    if((amount===null||!Number.isFinite(amount))&&lines[i+1]&&OCR_ONLY_PRICE.test(ocrLine(lines[i+1])))amount=ocrMoney(ocrLine(lines[i+1]).match(OCR_ONLY_PRICE)[1]);
    if(amount!==null&&Number.isFinite(amount)&&amount>0&&amount<10000000)candidates.push({amount,score,index:i,line:lines[i]});
  }
  if(!candidates.length)return{amount:null,source:'',candidates:[]};
  candidates.sort((a,b)=>b.score-a.score||b.index-a.index);
  return{amount:candidates[0].amount,source:candidates[0].line,candidates};
}
function ocrNearbyMoney(lines,index){
  const onLine=ocrLastMoney(lines[index]);
  if(Number.isFinite(onLine))return onLine;
  for(let j=index+1;j<=Math.min(lines.length-1,index+3);j++){
    const s=ocrLine(lines[j]);
    if(ocrIsSummaryStart(s)||/^(?:8|10)\s*[%％].*(?:税額|対象)|^お?預|^お?釣|^ポイント/i.test(ocrCompact(s)))break;
    if(OCR_ONLY_PRICE.test(s))return ocrMoney(s.match(OCR_ONLY_PRICE)[1]);
    if(/^(?:\d+\s*(?:点|品|個))$/.test(s))continue;
    break;
  }
  return null;
}
function ocrFindSubtotals(lines){
  const out=[];
  for(let i=0;i<lines.length;i++){
    const s=ocrSummaryLabel(lines[i]).replace(/^[（(]/,'');
    if(!/^(?:税抜小計|税別小計|税込小計|本体価格計|小計|商品小計|商品合計|税抜合計|本体合計|税別合計|\d{1,2}[%％](?:外税|内税|税抜|税込)?対象額)/.test(s))continue;
    const amount=ocrNearbyMoney(lines,i);
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
  for(let i=0;i<lines.length;i++){
    const s=ocrCompact(lines[i]);
    if(!/^(?:小計|商品小計|商品合計|合計)/.test(s))continue;
    let m=s.match(/(\d{1,3})\s*(?:点|品)(?!\w)/);
    if(!m){const n=ocrCompact(lines[i+1]||'');m=n.match(/^(\d{1,3})\s*(?:点|品)$/)}
    if(m)return Number(m[1]);
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
function ocrRateHint(item){
  if(item.taxRate)return{rate:item.taxRate,reliable:true};
  if(item.taxMark&&item.hasReducedMarkLegend)return{rate:8,reliable:true};
  // A rate inferred from a product name is advisory only: packaging and usage may change taxability.
  const s=item.name;
  if(/(?:ビール|チューハイ|ワイン|日本酒|焼酎|酒類|シャンプー|洗剤|歯ブラシ|ティッシュ|トイレット|化粧|乾電池|電池|文具)/i.test(s))return{rate:10,reliable:false};
  if(/(?:無洗米|精米|玄米|白米|お米|コシヒカリ|アカフジ|米\s*\d+kg|牛乳|パン|鶏肉|豚肉|卵|野菜|キャベツ|ブロッコリー|惣菜|弁当|飲料|お茶|ジュース|牛肉|納豆|豆腐)/i.test(s))return{rate:8,reliable:false};
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
function ocrAllocateTax(items,totalTax,taxes=[]){
  if(!items.length||totalTax<0||!Number.isFinite(totalTax))return[];
  const taxableIndices=items.map((item,i)=>item.taxKind!=='inclusive'?i:-1).filter(i=>i>=0);
  if(!taxableIndices.length)return items.map(()=>0);
  const groups=taxes.filter(t=>t.rate===8||t.rate===10);
  if(groups.length===2&&groups[0].amount+groups[1].amount===totalTax){
    // Use the tax amounts printed for each rate, not per-item rounded tax.
    // The group membership is provisional where the line itself does not specify a rate.
    const output=items.map(()=>0);let usable=true;
    for(const group of groups){
      const indices=taxableIndices.filter(i=>ocrRateHint(items[i]).rate===group.rate);
      if(!indices.length){usable=false;break;}
      const shares=ocrTaxShares(indices.map(i=>items[i].rawAmount),group.amount);
      indices.forEach((index,j)=>{output[index]=shares[j];});
    }
    if(usable)return output;
  }
  return ocrTaxShares(items.map(i=>i.taxKind==='inclusive'?0:i.rawAmount*ocrRateHint(i).rate),totalTax);
}
function ocrReconcile(items,allLines,totalInfo){
  const hasReducedLegend=allLines.some(line=>/(?:※|＊|\*)\s*印.*(?:軽減|8[%％])/.test(ocrLine(line)));
  items.forEach(i=>{i.hasReducedMarkLegend=hasReducedLegend;});
  const printedCount=ocrFindItemCount(allLines);
  const parsedCount=items.reduce((n,i)=>n+(i.qty||1),0);
  const rawSum=items.reduce((s,i)=>s+i.rawAmount,0);
  const total=totalInfo.amount;
  const taxes=ocrFindTaxes(allLines),subtotals=ocrFindSubtotals(allLines),discounts=ocrFindDiscounts(allLines);
  const observedTax=taxes.length?taxes.reduce((s,v)=>s+v.amount,0):null;
  const tolerance=1; // 1 yen for OCR+receipt-specific rounding; larger discrepancies are never silently cleared.
  const subtotalMatch=subtotals.some(x=>Math.abs(x.amount-rawSum)<=tolerance);
  const explicitNet=items.some(x=>x.taxKind==='exclusive')||subtotals.some(x=>/税抜|税別|本体/.test(x.compact))||taxes.some(x=>x.kind==='exclusive');
  const explicitGross=items.some(x=>x.taxKind==='inclusive')||subtotals.some(x=>/税込/.test(x.compact))||taxes.some(x=>x.kind==='inclusive');
  const result={mode:'unknown',status:'review',printedTotal:total,subtotal:subtotals.at(-1)?.amount??null,rawSum,itemSum:rawSum,observedTax,
    allocatedTax:0,difference:total===null?null:total-rawSum,hasDiscounts:discounts.length>0,discountLines:discounts,
    explanations:[],taxLines:taxes.map(v=>v.line),ignoredCount:0,printedCount,parsedCount};
  if(!items.length){result.explanations.push('商品行を読み取れませんでした。写真を見ながら明細を入力してください。');return result;}
  const diff=total===null?null:total-rawSum;
  if(total!==null&&Math.abs(diff)<=tolerance){
    result.mode='inclusive';result.status=Math.abs(diff)<=0.01&&!explicitNet?'match':'review';
    result.explanations.push('商品金額は税込として扱います。レシート合計との比較で二重課税を防ぎます。');
    if(Math.abs(diff)>0.01)result.explanations.push('合計に1円の差があります。端数処理や読み取りを確認してください。');
    if(explicitNet)result.explanations.push('税抜を示す表記もあります。表示の解釈を写真で確認してください。');
  }else if(total!==null&&diff>0){
    const taxProof=observedTax!==null&&Math.abs(observedTax-diff)<=tolerance;
    const taxLike=rawSum>0&&diff/rawSum>=.065&&diff/rawSum<=.115;
    const supported=!(explicitGross&&!explicitNet)&&(taxProof||(taxLike&&(explicitNet||subtotalMatch)&&!explicitGross));
    if(supported&&Math.abs(diff-Math.round(diff))<.01){
      result.mode='exclusive';result.allocatedTax=diff;
      const distribution=ocrAllocateTax(items,diff,taxes);
      items.forEach((item,i)=>{item.taxAdded=distribution[i];item.amount=item.rawAmount+distribution[i];});
      result.itemSum=items.reduce((a,b)=>a+b.amount,0);
      result.difference=total-result.itemSum;
      const allKnown=items.length===1||items.every(i=>ocrRateHint(i).reliable);
      result.status=taxProof&&allKnown&&subtotalMatch?'match':'review';
      result.explanations.push('税抜金額と判断し、レシート上の合計と一致するよう消費税 '+diff+'円を明細に配分しました。');
      if(!taxProof)result.explanations.push('税額の直接照合ができないため、税込換算は仮計算です。写真で確認してください。');
      if(!allKnown&&items.length>1)result.explanations.push('各商品の税率が特定できないため、税額の配分比率は推定です。商品別税込価格を確認してください。');
    }else{
      result.mode='unreconciled';result.explanations.push('明細の金額とレシート合計が一致しません。商品・値引き・税額の読み落としを写真で確認してください。');
    }
  }else if(total!==null){result.mode='unreconciled';result.explanations.push('明細合計がレシート合計を上回っています。商品行の重複や値引きの計上を確認してください。');}
  else if(explicitNet&&!explicitGross){
    result.mode='exclusive-estimated';const taxesEstimated=items.map(i=>Math.floor(i.rawAmount*ocrRateHint(i).rate/100));
    items.forEach((i,k)=>{i.taxAdded=taxesEstimated[k];i.amount=i.rawAmount+taxesEstimated[k]});
    result.itemSum=items.reduce((s,i)=>s+i.amount,0);result.allocatedTax=result.itemSum-rawSum;
    result.explanations.push('レシート合計が不明です。明示された税抜表記から参考税込額を算出しました。税率・端数処理の確認が必要です。');
  }else if(total===null){result.explanations.push('レシート合計が判別できません。明細と写真を照合してください。');}
  if(subtotals.length&&!subtotalMatch&&!(total!==null&&Math.abs(rawSum-total)<=1)){
    result.status='review';result.explanations.push('読み取った小計と商品明細の金額にも差があります。');
  }
  if(printedCount!==null&&parsedCount!==printedCount){result.status='review';result.explanations.push(`レシートは${printedCount}点ですが、抽出結果は${parsedCount}点です。明細の読み落としや数量を確認してください。`);}
  if(discounts.length){
    result.status='review';result.explanations.push('値引き・ポイント関連の行があります。支払手段のポイント利用と値引きは別なので、内容を確認してください。');
  }
  if(explicitNet&&explicitGross){result.status='review';result.explanations.push('税込・税抜の表示が混在しています。商品別の税の扱いを確認してください。');}
  if(!items.length)result.status='review';
  return result;
}
function ocrExtractReceipt(raw,layoutLines=[]){
  const textLines=String(raw||'').normalize('NFKC').replace(/[\r\u0000]/g,'').split('\n').map(ocrLine).filter(Boolean);
  const geoLines=Array.isArray(layoutLines)?layoutLines.slice(0,400).map(x=>ocrLine(typeof x==='string'?x:x?.text)).filter(Boolean):[];
  const totalInfo=ocrFindTotal(textLines.length?textLines:geoLines);
  const total=totalInfo.amount??ocrFindTotal(geoLines).amount;
  const sources=[{label:'OCR文字列',lines:textLines,parsed:ocrParseItemLines(textLines)}];
  if(geoLines.length)sources.push({label:'文字の位置情報',lines:geoLines,parsed:ocrParseItemLines(geoLines)});
  const assessments=sources.map(src=>{
    const items=src.parsed.items.map(i=>({...i}));
    const rec=ocrReconcile(items,textLines.length?textLines:src.lines,{...totalInfo,amount:total});
    const delta=rec.difference===null?999999:Math.abs(rec.difference);
    const exact=rec.status==='match'&&delta===0;
    // More lines alone is not quality: strong preference for complete, reconciled receipts.
    const score=(exact?10000:0)+(delta<=1?300:0)+items.length*10-Math.min(800,delta/2)-src.parsed.ignored.length*.01;
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
  return{merchant:ocrMerchant(textLines.length?textLines:geoLines),date,total:rec.printedTotal,items:selected.items,warnings,
    rawLineCount:textLines.length,parsedSource:selected.src.label,lineSum:rec.itemSum,ignoredLines:selected.src.parsed.ignored.slice(0,60),
    reconciliation:rec};
}
