'use strict';
const KEY='receipt-ledger-data-v1';
const GROUPS={'食材':['肉類','魚介類','野菜','果物','米・麺類','卵・乳製品','豆製品','その他'],'調味料':['基本調味料','油・ドレッシング','香辛料','料理の素','その他'],'食品・飲料':['惣菜・弁当','冷凍食品','インスタント食品','デザート・ヨーグルト','菓子','飲料','その他'],'日用品':['洗剤','掃除用品','衛生用品','キッチン用品','消耗品','その他'],'家具・家電':['家具','家電','PC・周辺機器','インテリア','その他'],'衣類・美容':['衣類','スキンケア','ヘアケア','理美容用品','その他'],'その他':['趣味','医薬品','雑貨','未分類']};
const DEFAULT={schemaVersion:1,books:[{id:'personal',name:'個人用',kind:'personal'},{id:'shared',name:'共有用（この端末内）',kind:'shared'}],activeBook:'personal',purchases:[],aliases:{}};
const $=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const yen=n=>'¥'+Number(n||0).toLocaleString('ja-JP');const uid=()=>crypto.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2);const today=()=>new Date().toLocaleDateString('sv-SE');
let state;try{state=JSON.parse(localStorage.getItem(KEY))||structuredClone(DEFAULT)}catch{state=structuredClone(DEFAULT)}if(!Array.isArray(state.books)||!Array.isArray(state.purchases))state=structuredClone(DEFAULT);state.aliases||={};state.learnedRules||=[];let pendingImages=[];
function persist(){if(window.cloudMode)return;try{localStorage.setItem(KEY,JSON.stringify(state))}catch{alert('保存容量が不足しています。JSONバックアップを保存してください。');throw Error('storage full')}}
function toast(msg){$('toast').textContent=msg;$('toast').style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').style.display='none',3500)}
function active(){return state.purchases.filter(p=>p.bookId===state.activeBook)}
function normalize(raw){const text=String(raw||'').trim();if(state.aliases[text])return state.aliases[text];const patterns=[[/鶏.{0,5}(もも|モモ)|若鶏.{0,5}モモ|ブラ.{0,4}モモ/i,'鶏もも肉'],[/しょうゆ|醤油/i,'しょうゆ'],[/キャベツ/i,'キャベツ']];return patterns.find(([r])=>r.test(text))?.[1]||text}
function guessCategory(raw){const s=String(raw||'');if(/(?:無洗米|精米|玄米|白米|もち米|コシヒカリ|あきたこまち|ひとめぼれ|つや姫|ゆめぴりか|ななつぼし|ササニシキ|新米|国産米|お米|アカフジ|あかふじ|(?:^|[\s　*＊])米(?:$|[\s　0-9０-９])|(?:^|[\s　*＊])コメ(?:$|[\s　0-9０-９])|[0-9０-９]+\s*(?:kg|キロ)\s*(?:米|コメ))/i.test(s))return ['食材','米・麺類'];if(/(?:うちのごはん|麻婆(?:豆腐|茄子)の素|マーボー(?:豆腐|なす)の素|回鍋肉の素|青椒肉絲の素|クックドゥ|Cook\s*Do|料理の素|おかずの素|鍋の素|炊き込みご飯の素|シーズニング)/i.test(s))return ['調味料','料理の素'];if(/(?:ヨーグルト|プリン|ゼリー|杏仁豆腐|ババロア|ムース|デザート|アイスクリーム|アイスミルク)/.test(s))return ['食品・飲料','デザート・ヨーグルト'];if(/鶏|豚|牛肉|モモ肉|もも肉|ひき肉|ウインナー|ソーセージ|ベーコン|ハム/.test(s))return ['食材','肉類'];if(/キャベツ|白菜|にんじん|玉ねぎ|レタス|きゅうり/.test(s))return ['食材','野菜'];if(/醤油|しょうゆ|塩|砂糖|みりん|味噌|マヨネーズ/.test(s))return ['調味料','基本調味料'];if(/洗剤|洗濯|柔軟剤/.test(s))return ['日用品','洗剤'];if(/牛乳|チーズ|卵/.test(s))return ['食材','卵・乳製品'];return ['その他','未分類']}
// v0.6: purchase dates are immutable accounting facts; allocation months may differ.
function monthIsValid(month){return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month||''));}
function amountCents(n){return Math.round(Number(n||0)*100);}
function centsAmount(n){return Math.round(n)/100;}
const MEAL_TYPES=[['breakfast','朝食用'],['lunch','昼食用'],['dinner','夕食用']];
function mealAmounts(item){
  const stored=item?.mealAllocations;
  if(!stored||typeof stored!=='object'||Array.isArray(stored))return {breakfast:0,lunch:0,dinner:Number(item?.amount||0)};
  return {breakfast:Number(stored.breakfast||0),lunch:Number(stored.lunch||0),dinner:Number(stored.dinner||0)};
}
function mealPortionCents(item,portionAmount){
  const cents=amountCents(portionAmount),total=amountCents(item.amount),values=mealAmounts(item);
  const weights=MEAL_TYPES.map(([key])=>amountCents(values[key]));
  if(total<=0||weights.some(n=>n<0)||weights.reduce((a,b)=>a+b,0)!==total)return [0,0,cents];
  const raw=weights.map(n=>n*cents/total),parts=raw.map(Math.floor);
  const order=raw.map((n,i)=>({i,frac:n-parts[i]})).sort((a,b)=>b.frac-a.fr||a.i-b.i);
  const remainder=cents-parts.reduce((a,b)=>a+b,0);
  for(let j=0;j<remainder;j++)parts[order[j%order.length].i]++;
  return parts;
}
function monthShift(month, offset){
  const m=monthIsValid(month)?month:today().slice(0,7);
  const d=new Date(Date.UTC(Number(m.slice(0,4)),Number(m.slice(5))-1+offset,1));
  return d.toISOString().slice(0,7);
}
function accountingAllocations(p,item){
  const found=Array.isArray(item.allocations)?item.allocations:[];
  if(found.length)return found.map(a=>({month:a.month,amount:Number(a.amount),quantity:a.quantity==null?null:Number(a.quantity),quantity_unit:a.quantity_unit||item.unit||'個',allocation_mode:a.allocation_mode||'manual'}));
  return [{month:(p.date||today()).slice(0,7),amount:Number(item.amount||0),quantity:null}];
}
function accountingTotalQuantity(item){
  const qty=Number(item.qty||1),size=item.size==null?null:Number(item.size);
  return size!=null&&size>0?qty*size:qty;
}
function monthRows(month,mode='accounted'){
  const rows=[];
  for(const p of active())for(const item of p.items){
    const portions=mode==='purchased'?[{month:(p.date||'').slice(0,7),amount:Number(item.amount),quantity:null}]:accountingAllocations(p,item);
    for(const a of portions)if(a.month===month)rows.push({purchase:p,item,amount:Number(a.amount),quantity:a.quantity});
  }
  return rows;
}
function allocationDisplayQuantity(item,a){
  if(a.quantity==null)return '';
  const base=item.unit||'個',display=a.quantity_unit||base;
  const factor={g:1,kg:1000,ml:1,L:1000};
  const group=u=>['g','kg'].includes(u)?'mass':['ml','L'].includes(u)?'volume':'count:'+u;
  const value=group(base)===group(display)&&factor[base]&&factor[display]
    ?Number(a.quantity)*factor[base]/factor[display]:Number(a.quantity);
  const unit=group(base)===group(display)?display:base;
  return (Math.round(value*1e6)/1e6).toLocaleString('ja-JP')+unit;
}
function allocationShortLabel(p,item){
  return accountingAllocations(p,item).map(a=>`${esc(a.month)}分 ${yen(a.amount)}${a.quantity!=null?' / '+esc(allocationDisplayQuantity(item,a)):''}`).join(' ／ ');
}

function bookOptions(){const sel=$('book');sel.innerHTML=state.books.map(b=>`<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');sel.value=state.activeBook}
function addRow(item={}){const wrap=document.createElement('div');wrap.className='item-row';const guessed=guessCategory(item.name);const cat=item.category||guessed[0],sub=item.subcategory||guessed[1];wrap.innerHTML=`<div class="item-head"><strong>商品</strong><button class="remove" type="button">削除</button></div><div class="item-grid"><label class="wide">商品名<input class="raw" placeholder="例：国産若鶏モモ300G" value="${esc(item.name||'')}"></label><label>税込金額（円）<input class="amount" type="number" min="0" step="1" value="${item.amount??''}"></label><label>計上月（購入日とは別）<input class="account-month" type="month" value="${esc(item.accountMonth||$('purchaseDate').value.slice(0,7)||today().slice(0,7))}"></label><label>数量<input class="qty" type="number" min="0.001" step="any" value="${item.qty??1}"></label><label>1購入単位あたりの容量・本数など<input class="size" type="number" min="0" step="any" placeholder="例：300" value="${item.size??''}"></label><label>単位<select class="unit"><option value="g">g</option><option value="kg">kg</option><option value="ml">ml</option><option value="L">L</option><option value="個">個</option><option value="本">本</option><option value="枚">枚</option><option value="袋">袋</option><option value="パック">パック</option><option value="箱">箱</option><option value="食">食</option><option value="束">束</option><option value="粒">粒</option><option value="杯">杯</option><option value="切れ">切れ</option><option value="組">組</option><option value="セット">セット</option><option value="缶">缶</option><option value="瓶">瓶</option><option value="回">回</option></select></label><label>大分類<select class="category">${Object.keys(GROUPS).map(x=>`<option>${x}</option>`).join('')}</select></label><label>小分類<select class="subcategory"></select></label><label>産地（任意）<input class="origin" placeholder="例：国産" value="${esc(item.origin||'')}"></label><label>状態<select class="state"><option value="">不明</option><option>冷凍</option><option>冷蔵</option><option>常温</option></select></label></div>`;
wrap.querySelector('.remove').onclick=()=>{wrap.remove();updateFormTotal()};const catEl=wrap.querySelector('.category'),subEl=wrap.querySelector('.subcategory');const updateSubs=()=>{subEl.innerHTML=GROUPS[catEl.value].map(x=>`<option>${x}</option>`).join('')};catEl.value=cat;updateSubs();subEl.value=sub;wrap.querySelector('.unit').value=item.unit||'g';wrap.querySelector('.state').value=item.state||'';catEl.onchange=()=>{wrap.dataset.manualCategory='yes';updateSubs()};subEl.onchange=()=>{wrap.dataset.manualCategory='yes'};
wrap.querySelector('.raw').onchange=()=>{
  const name=wrap.querySelector('.raw').value;
  const prediction=window.smartPredictCategory?.(name);
  const [fallbackMajor,fallbackMinor]=guessCategory(name);
  if(wrap.dataset.manualCategory!=='yes'){
    const use=prediction?.autoApply;
    catEl.value=use?prediction.major:fallbackMajor;
    updateSubs();subEl.value=use?prediction.minor:fallbackMinor;
  }
  let note=wrap.querySelector('.smart-inline-note');
  if(!note){note=document.createElement('p');note.className='smart-inline-note';wrap.append(note)}
  note.textContent=prediction?(prediction.autoApply?'分類推測：'+prediction.major+' ＞ '+prediction.minor+'（'+prediction.label+'）':'分類の候補：'+prediction.major+' ＞ '+prediction.minor+'（要確認）')+(wrap.dataset.manualCategory==='yes'?'／手動選択を優先':''):'';
};wrap.querySelector('.amount').oninput=updateFormTotal;$('itemInputs').append(wrap);updateFormTotal()}
function updateFormTotal(){let total=0;document.querySelectorAll('.item-row .amount').forEach(x=>total+=Number(x.value)||0);$('formTotal').textContent='合計 '+yen(total)}
function rowData(row){const v=c=>row.querySelector('.'+c).value;const name=v('raw').trim(),amount=Number(v('amount')),qty=Number(v('qty')),size=v('size')===''?null:Number(v('size'));if(!name||!Number.isFinite(amount)||amount<0||!Number.isFinite(qty)||qty<=0||size!==null&&(!Number.isFinite(size)||size<0))throw Error('商品名・金額・数量を正しく入力してください。');const month=v('account-month');if(!monthIsValid(month))throw Error('計上月を正しく入力してください。');return{id:uid(),name,canonical:normalize(name),amount,qty,size,unit:v('unit'),category:v('category'),subcategory:v('subcategory'),origin:v('origin').trim(),state:v('state'),allocations:[{month,amount,quantity:null}]}}
function savePurchase(){if(window.cloudMode)return window.cloudSavePurchaseFromForm();const rows=[...document.querySelectorAll('.item-row')];if(!rows.length)return toast('商品を追加してください');try{const items=rows.map(rowData),purchase={id:uid(),bookId:state.activeBook,date:$('purchaseDate').value||today(),merchant:$('merchant').value.trim()||'購入先未設定',source:'manual',items,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};state.purchases.unshift(purchase);persist();$('itemInputs').innerHTML='';addRow();$('merchant').value='';refresh();toast('購入を登録しました')}catch(e){toast(e.message)}}
// Native pickers normally open from their small calendar icon; showPicker enables
// clicking the displayed year/month/day text as well. Runs only on user gestures.
function installDatePickerWholeField(){
  document.addEventListener('click',event=>{
    const input=event.target.closest?.('input[type="date"],input[type="month"]');
    if(!input||input.disabled||input.readOnly)return;
    if(typeof input.showPicker==='function'){
      try{input.showPicker();}catch(error){ /* platform-native fallback */ }
    }
  },true);
  document.addEventListener('keydown',event=>{
    if(event.key!=='Enter'&&event.key!==' ')return;
    const input=event.target;
    if(!input?.matches?.('input[type="date"],input[type="month"]')||input.disabled||input.readOnly)return;
    if(typeof input.showPicker==='function'){
      try{input.showPicker();event.preventDefault();}catch(error){ /* allow native editing */ }
    }
  });
}
const DASHBOARD_CHART_KEY='receipt-ledger-chart-view-v07';
const DASHBOARD_PIE_LEVEL_KEY='receipt-ledger-pie-level-v07';
let dashboardChartView='bar';
const FOOD_MAJORS=['食材','調味料','食品・飲料'];
let foodDrillSub=null;
let foodSlices=[];
const DASHBOARD_PIE_COLORS=['#23836c','#db8e40','#6188bd','#b96f92','#8375b5','#6c9b42','#d26e5e','#4f91a2','#b2a03c','#956c56','#537e5a','#a36da4'];
function categoryColor(index){return DASHBOARD_PIE_COLORS[index%DASHBOARD_PIE_COLORS.length]}
function chartPrefsRead(){
  try{
    if(localStorage.getItem(DASHBOARD_CHART_KEY)==='pie')dashboardChartView='pie';
    const level=localStorage.getItem(DASHBOARD_PIE_LEVEL_KEY);
    if(level==='minor')$('pieCategoryLevel').value='minor';
  }catch{}
  chartButtonsUpdate();
}
function chartButtonsUpdate(){
  const pie=dashboardChartView==='pie';
  $('barChartPanel').hidden=pie;$('pieChartPanel').hidden=!pie;
  $('chartBarButton').classList.toggle('selected',!pie);
  $('chartPieButton').classList.toggle('selected',pie);
  $('chartBarButton').setAttribute('aria-pressed',String(!pie));
  $('chartPieButton').setAttribute('aria-pressed',String(pie));
}
function setChartView(view){
  dashboardChartView=view==='pie'?'pie':'bar';
  try{localStorage.setItem(DASHBOARD_CHART_KEY,dashboardChartView)}catch{}
  chartButtonsUpdate();renderDashboard();
}
// The dedicated food chart always follows the currently selected accounting/purchase month.
// These choices are presentation only: no changes to purchase records or cloud data.
function showFoodMajor(major){
  if(!FOOD_MAJORS.includes(major))return;
  $('foodScope').value=major;
  foodDrillSub=null;
  renderDashboard();
  $('foodBreakdownCard').scrollIntoView({behavior:'smooth',block:'start'});
  $('foodBreakdownCard').focus({preventScroll:true});
}
function pieSegmentAtClick(ev,slices){
  if(!slices.length)return null;
  const box=ev.currentTarget.getBoundingClientRect();
  const x=ev.clientX-box.left-box.width/2,y=ev.clientY-box.top-box.height/2;
  if(x*x+y*y>Math.pow(Math.min(box.width,box.height)/2,2))return null;
  // CSS conic-gradient(from -90deg) starts at the left edge.
  const fraction=((Math.atan2(y,x)*180/Math.PI+180+360)%360)/360;
  return slices.find(s=>fraction>=s.from/100-1e-8&&fraction<s.to/100+1e-8)||slices[slices.length-1];
}
function foodScopeRows(rows){
  const scope=$('foodScope').value;
  return rows.filter(r=>FOOD_MAJORS.includes(r.item.category)&&(scope==='all'||r.item.category===scope));
}
function renderFoodPie(rows,month,mode){
  const scope=$('foodScope').value;
  const foodRows=foodScopeRows(rows);
  const total=foodRows.reduce((sum,r)=>sum+amountCents(r.amount),0);
  const root=$('foodPieContent');
  $('foodMonth').textContent=month.replace('-','年')+'月';
  $('foodTotal').textContent=yen(centsAmount(total));
  const crumb=$('foodCrumb');
  if(foodDrillSub){
    crumb.hidden=false;
    $('foodBack').textContent='← 小分類一覧に戻る';
    $('foodCurrent').textContent=foodDrillSub.replace(' / ',' ＞ ');
  }else{crumb.hidden=true;}
  if(total<=0){foodDrillSub=null;crumb.hidden=true;$('foodItemBreakdown').hidden=true;$('foodItemBreakdown').innerHTML='';root.innerHTML='<div class="empty">対象月の食費はまだありません。食品を登録すると、ここに内訳が表示されます。</div>';return;}
  const scopedRows=foodDrillSub?foodRows.filter(r=>(r.item.category||'その他')+' / '+(r.item.subcategory||'未分類')===foodDrillSub):foodRows;
  if(!scopedRows.length){foodDrillSub=null;return renderFoodPie(rows,month,mode);}
  const sums=new Map();
  for(const r of scopedRows){
    const label=foodDrillSub?(r.item.canonical||r.item.name):((r.item.category||'その他')+' / '+(r.item.subcategory||'未分類'));
    sums.set(label,(sums.get(label)||0)+amountCents(r.amount));
  }
  const entries=[...sums].filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
  const shownTotal=entries.reduce((sum,[,val])=>sum+val,0);
  if(!shownTotal){root.innerHTML='<div class="empty">グラフに表示できる支出がありません。</div>';return;}
  let acc=0;
  const slices=entries.map(([name,value],index)=>{
    const from=acc/shownTotal*100;acc+=value;
    return {name,value,from,to:acc/shownTotal*100,percent:value/shownTotal*100,color:categoryColor(index)};
  });
  foodSlices=slices;
  const gradient=slices.map(s=>`${s.color} ${s.from.toFixed(8)}% ${s.to.toFixed(8)}%`).join(',');
  const current=foodDrillSub?foodDrillSub.replace(' / ',' ＞ '):'食費の小分類';
  const label=`${month.replace('-','年')}月の${current}。${slices.map(s=>s.name+' '+s.percent.toFixed(1)+'%').join('、')}`;
  const legend=slices.map((s,i)=>{
    const content=`<span class="pie-swatch" style="background:${s.color}" aria-hidden="true"></span><span class="pie-name">${esc(s.name.replace(' / ',' ＞ '))}</span><span class="pie-amount">${yen(centsAmount(s.value))}</span><strong class="pie-percent">${s.percent.toFixed(1)}%</strong>`;
    return foodDrillSub?`<div class="pie-legend-row">${content}</div>`:
      `<button type="button" class="pie-legend-row food-pie-choice" data-food-index="${i}" aria-label="${esc(s.name.replace(' / ',' ＞ '))}の商品の内訳を見る">${content}<span class="food-next" aria-hidden="true">›</span></button>`;
  }).join('');
  root.innerHTML=`<div class="pie-chart food-clickable-pie" style="background:conic-gradient(from -90deg,${gradient})" role="img" aria-label="${esc(label)}" title="凡例の分類名を押すと商品別の内訳を表示します"></div><div class="pie-legend"><p class="pie-sum">${foodDrillSub?'この小分類の合計':'食費の合計'} <strong>${yen(centsAmount(shownTotal))}</strong></p>${legend}</div>`;
  root.querySelectorAll('[data-food-index]').forEach(b=>b.onclick=()=>{
    const idx=Number(b.dataset.foodIndex);
    if(!foodDrillSub&&slices[idx]){foodDrillSub=slices[idx].name;renderFoodPie(rows,month,mode)}
  });
  if(!foodDrillSub){
    const wheel=root.querySelector('.food-clickable-pie');
    wheel.classList.add('interactive-pie');
    wheel.addEventListener('click',e=>{const slice=pieSegmentAtClick(e,slices);if(slice){foodDrillSub=slice.name;renderFoodPie(rows,month,mode)}});
  }
  const list=$('foodItemBreakdown');
  if(foodDrillSub){
    const lines=scopedRows.slice().sort((a,b)=>b.amount-a.amount).map(r=>
      `<div class="allocated-line"><div><strong>${esc(r.item.name)}</strong><small>${esc(r.purchase.merchant)} · 購入日 ${esc(r.purchase.date)}${r.quantity!=null?' · 配分数量 '+esc(r.quantity)+' '+esc(r.item.unit||'個'):''}</small></div><strong>${yen(r.amount)}</strong></div>`).join('');
    list.hidden=false;
    list.innerHTML=`<h4>該当する購入明細</h4>${lines}`;
  }else{list.hidden=true;list.innerHTML='';}
}
function pieDataForRows(rows,level){
  const sums=new Map();
  for(const row of rows){
    const category=row.item.category||'その他';
    const sub=row.item.subcategory||'未分類';
    const name=level==='minor'?`${category} / ${sub}`:category;
    sums.set(name,(sums.get(name)||0)+amountCents(row.amount));
  }
  return [...sums.entries()].filter(([_,amount])=>amount>0).sort((a,b)=>b[1]-a[1]);
}
function renderCategoryPie(rows,month,mode){
  const level=$('pieCategoryLevel').value;
  const entries=pieDataForRows(rows,level),total=entries.reduce((sum,[,value])=>sum+value,0);
  if(total===0){$('categoryPieContent').innerHTML='<div class="empty">円グラフに表示する支出がありません。</div>';return}
  let acc=0;
  const slices=entries.map(([label,value],index)=>{
    const from=acc/total*100;acc+=value;
    const to=acc/total*100;
    return {label,value,color:categoryColor(index),percent:value/total*100,from,to};
  });
  // Two equal-angle stops with the same color produce a crisp pie wedge.
  const gradient=slices.map(s=>`${s.color} ${s.from.toFixed(8)}% ${s.to.toFixed(8)}%`).join(',');
  const label=`${month.replace('-','年')}月・${mode==='accounted'?'計上月':'購入月'}：${slices.map(s=>s.label+' '+s.percent.toFixed(1)+'%').join('、')}`;
  const legend=slices.map(s=>{
    const body=`<span class="pie-swatch" style="background:${s.color}" aria-hidden="true"></span><span class="pie-name">${esc(s.label)}</span><span class="pie-amount">${yen(centsAmount(s.value))}</span><strong class="pie-percent">${s.percent.toFixed(1)}%</strong>`;
    const major=level==='minor'?s.label.split(' / ')[0]:s.label;
    return FOOD_MAJORS.includes(major)?`<button type="button" class="pie-legend-row pie-legend-link" data-food-major="${esc(major)}" title="食費の内訳を表示">${body}<span class="food-next" aria-hidden="true">›</span></button>`:`<div class="pie-legend-row">${body}</div>`;
  }).join('');
  $('categoryPieContent').innerHTML=`<div class="pie-chart" style="background:conic-gradient(from -90deg,${gradient})" role="img" aria-label="${esc(label)}"></div><div class="pie-legend"><p class="pie-sum">支出合計 <strong>${yen(centsAmount(total))}</strong></p>${legend}</div>`;
  $('categoryPieContent').querySelectorAll('[data-food-major]').forEach(b=>b.onclick=()=>showFoodMajor(b.dataset.foodMajor));
  if(level==='major'){
    const segments=$('categoryPieContent').querySelector('.pie-chart');
    segments.classList.add('interactive-pie');
    segments.title='食材・調味料・食品・飲料の扇形を押すと、食費の内訳へ移動します';
    segments.addEventListener('click',e=>{const picked=pieSegmentAtClick(e,slices.map(s=>({...s,name:s.label})));if(picked)showFoodMajor(picked.label)});
  }
}
function renderDashboard(){
  const month=$('month').value,mode=$('accountingMode').value;
  const rows=monthRows(month,mode), sumCents=rows.reduce((s,r)=>s+amountCents(r.amount),0);
  $('monthlyTotal').textContent=yen(centsAmount(sumCents));
  $('monthlyItems').textContent=new Set(rows.map(r=>r.item.id)).size;
  $('monthlyReceipts').textContent=new Set(rows.map(r=>r.purchase.id)).size;
  let mealPanel=$('mealSummary');
  if(!mealPanel){mealPanel=document.createElement('article');mealPanel.id='mealSummary';mealPanel.className='meal-summary';
    $('monthlyTotal').closest('article').parentElement.after(mealPanel);}
  const mealTotals=[0,0,0];
  rows.filter(r=>['食材','調味料','食品・飲料'].includes(r.item.category)).forEach(r=>{
    mealPortionCents(r.item,r.amount).forEach((amount,i)=>mealTotals[i]+=amount);
  });
  mealPanel.innerHTML='<h3>食事区分別の食費</h3><p class="muted">食材・調味料・食品・飲料のみ。未設定の商品は夕食用に集計します。</p><div class="meal-summary-grid">'+
    MEAL_TYPES.map(([,name],i)=>`<div><small>${name}</small><strong>${yen(centsAmount(mealTotals[i]))}</strong></div>`).join('')+'</div>';
  $('accountingExplanation').textContent=mode==='accounted'?
    '「計上月」で集計中。購入日が前月でも、その月分として配分した金額だけを含みます。':
    '「購入月」で集計中。支払った月に、各商品の購入金額をまとめて表示します。';
  const sums={};for(const r of rows)sums[r.item.category]=(sums[r.item.category]||0)+amountCents(r.amount);
  const max=Math.max(1,...Object.values(sums));
  $('categoryBars').innerHTML=Object.entries(sums).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="bar"><div class="bar-head">${FOOD_MAJORS.includes(k)?`<button type="button" class="bar-food-link" data-food-major="${esc(k)}" title="食費の内訳を見る">${esc(k)} <span aria-hidden="true">›</span></button>`:`<span>${esc(k)}</span>`}<strong>${yen(centsAmount(v))}</strong></div><div class="track"><div class="fill" style="width:${v/max*100}%"></div></div></div>`).join('')||'<div class="empty">この月の計上履歴はありません。</div>';
  $('categoryBars').querySelectorAll('[data-food-major]').forEach(b=>b.onclick=()=>showFoodMajor(b.dataset.foodMajor));
  renderCategoryPie(rows,month,mode);
  renderFoodPie(rows,month,mode);
  const cats=new Map();
  for(const r of rows){const category=r.item.category||'その他',sub=r.item.subcategory||'未分類';
    if(!cats.has(category))cats.set(category,new Map());
    if(!cats.get(category).has(sub))cats.get(category).set(sub,[]);
    cats.get(category).get(sub).push(r);
  }
  const subtotal=rs=>centsAmount(rs.reduce((s,r)=>s+amountCents(r.amount),0));
  const catRows=[...cats.entries()].map(([cat,subs])=>{
    const all=[...subs.values()].flat();return {cat,subs,total:subtotal(all)};
  }).sort((a,b)=>b.total-a.total);
  $('categoryDetails').innerHTML=catRows.map(({cat,subs,total})=>`<details class="category-detail"><summary><strong>${esc(cat)}</strong><strong>${yen(total)}</strong></summary>
    <div class="sub-list">${[...subs.entries()].map(([sub,list])=>({sub,list,total:subtotal(list)})).sort((a,b)=>b.total-a.total).map(({sub,list,total})=>
      `<details class="subcategory-detail"><summary><span>${esc(sub)} <small>${list.length}明細</small></span><strong>${yen(total)}</strong></summary><div class="allocated-items">${list.sort((a,b)=>b.amount-a.amount).map(r=>
      `<div class="allocated-line"><div><strong>${esc(r.item.name)}</strong><small>${esc(r.purchase.merchant)} · 購入日 ${esc(r.purchase.date)}${r.quantity!=null?' · 配分数量 '+esc(r.quantity)+' '+esc(r.item.unit||'個'):''}</small></div><strong>${yen(r.amount)}</strong></div>`
      ).join('')}</div></details>`).join('')}</div></details>`).join('')||'<div class="empty">内訳がありません。</div>';
  const months=Array.from({length:6},(_,i)=>monthShift(month,i-5));
  const series=months.map(m=>({month:m,total:monthRows(m,mode).reduce((s,r)=>s+amountCents(r.amount),0)}));
  const maxTrend=Math.max(1,...series.map(s=>s.total));
  $('monthTrend').innerHTML=series.map(s=>`<div class="trend-cell${s.month===month?' current':''}"><div class="trend-value">${yen(centsAmount(s.total))}</div><div class="trend-track"><div class="trend-fill" style="height:${s.total?Math.max(2,s.total/maxTrend*100):0}%"></div></div><small>${esc(s.month.replace('-','/'))}</small></div>`).join('');
}
function renderHistory(){const q=$('historySearch').value.toLowerCase(),mode=$('historyMode').value;const ps=active().filter(p=>(p.merchant+' '+p.items.map(i=>i.name+' '+i.canonical).join(' ')).toLowerCase().includes(q));const root=$('historyList');if(mode==='receipt'){root.innerHTML=ps.map(p=>`<div class="history-card"><details><summary class="receipt-head"><span><strong>${esc(p.merchant)}</strong><br><small>${esc(p.date)} · ${p.items.length}商品${p.reviewStatus==='needs_review'?' · 要確認':''}</small></span><strong>${yen(p.items.reduce((s,i)=>s+i.amount,0))}</strong></summary><div><button data-edit-purchase="${esc(p.id)}" class="secondary">購入全体を編集・明細を分割</button>${p.items.map(i=>`<div class="line"><span>${esc(i.name)} <small>（${esc(i.category)} ＞ ${esc(i.subcategory)}）</small><br><small class="allocation-history">計上：${allocationShortLabel(p,i)}</small></span><span>${yen(i.amount)} <button data-edit="${esc(p.id)}" data-item="${esc(i.id)}" class="secondary">編集</button></span></div>`).join('')}</div><button data-delete="${esc(p.id)}" class="secondary">この購入を削除</button></details></div>`).join('')}else{root.innerHTML=ps.flatMap(p=>p.items.map(i=>`<div class="history-card"><div class="line"><span><strong>${esc(i.canonical)}</strong><br><small>${esc(p.date)} · ${esc(p.merchant)} · ${esc(i.category)} ＞ ${esc(i.subcategory)}</small><br><small class="allocation-history">計上：${allocationShortLabel(p,i)}</small></span><span>${yen(i.amount)} <button data-edit="${esc(p.id)}" data-item="${esc(i.id)}" class="secondary">編集</button></span></div></div>`)).join('')}if(!root.innerHTML)root.innerHTML='<div class="empty">購入履歴がありません。</div>';root.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>{if(!confirm('この購入を削除しますか？ 削除前にバックアップをおすすめします。'))return;if(window.cloudMode){window.cloudDeletePurchase(b.dataset.delete);return;}state.purchases=state.purchases.filter(p=>p.id!==b.dataset.delete);persist();refresh()});root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editItem(b.dataset.edit,b.dataset.item));root.querySelectorAll('[data-edit-purchase]').forEach(b=>b.onclick=()=>window.openPurchaseEditor(b.dataset.editPurchase))}
function editItem(pid,iid){if(typeof window.openPurchaseEditor==='function')window.openPurchaseEditor(pid,iid);else toast('編集機能の読み込みに失敗しました。再読み込みしてください。')}
function unitPrice(i){if(i.size&&i.size>0){const units={g:['g',1,100],kg:['g',1000,100],ml:['ml',1,100],L:['ml',1000,100]};const u=units[i.unit];if(u)return{value:i.amount/(i.size*u[1]*i.qty)*u[2],unit:'100'+u[0]}}if(i.size&&i.size>0&&['個','本','枚','袋','パック','箱','食','束','粒','杯','切れ','組','セット','缶','瓶','回'].includes(i.unit))return{value:i.amount/(i.size*i.qty),unit:'1'+i.unit};if(i.qty>0)return{value:i.amount/i.qty,unit:'1購入単位'};return null}
function renderCompare(){const q=$('compareSearch').value.trim().toLowerCase(),period=$('period').value,origin=$('originFilter').value.trim(),status=$('stateFilter').value;const now=new Date();const start=period==='all'?null:period==='custom'?$('fromDate').value:new Date(now.getTime()-Number(period)*86400000).toISOString().slice(0,10);const end=period==='custom'?$('toDate').value:today();const rows=active().flatMap(p=>p.items.map(i=>({...i,merchant:p.merchant,date:p.date}))).filter(i=>(!q||i.canonical.toLowerCase().includes(q))&&(!start||i.date>=start)&&i.date<=end&&(!origin||i.origin.includes(origin))&&(!status||i.state===status));const grouped={};rows.forEach(i=>(grouped[i.canonical]??=[]).push(i));const html=Object.entries(grouped).sort((a,b)=>a[0].localeCompare(b[0],'ja')).map(([name,items])=>{const prices=items.map(i=>({...i,price:unitPrice(i)}));const byUnit={};prices.forEach(i=>{if(i.price)(byUnit[i.price.unit]??=[]).push(i)});return `<article><h3>${esc(name)} <span class="tag">${items.length}件</span></h3>${Object.entries(byUnit).map(([unit,rs])=>`<div class="compare-summary"><article><small>${esc(unit)}あたり最安</small><strong>${yen(Math.round(Math.min(...rs.map(r=>r.price.value))*100)/100)}</strong></article><article><small>${esc(unit)}あたり平均</small><strong>${yen(Math.round(rs.reduce((s,r)=>s+r.price.value,0)/rs.length*100)/100)}</strong></article></div>`).join('')}<div class="table-scroll"><table><thead><tr><th>購入日</th><th>購入先</th><th>産地・状態</th><th>購入金額</th><th>換算単価</th></tr></thead><tbody>${prices.map(i=>`<tr><td>${esc(i.date)}</td><td>${esc(i.merchant)}</td><td>${esc(i.origin||'不明')}・${esc(i.state||'不明')}</td><td>${yen(i.amount)}</td><td>${i.price?yen(Math.round(i.price.value*100)/100)+' / '+esc(i.price.unit):'算出不可'}</td></tr>`).join('')}</tbody></table></div><small class="muted">「1購入単位」は重量・容量が不明な場合の参考値です。100g単価とは比較しません。</small></article>`}).join('');$('comparison').innerHTML=html||'<div class="empty">該当する購入履歴がありません。</div>'}
function renderAliases(){$('aliasList').innerHTML=Object.entries(state.aliases).map(([k,v])=>`<div class="line"><span>${esc(k)} → ${esc(v)}</span><button class="secondary" data-alias="${encodeURIComponent(k)}">削除</button></div>`).join('')||'<p class="muted">登録済みルールはありません。</p>';$('aliasList').querySelectorAll('[data-alias]').forEach(b=>b.onclick=()=>{delete state.aliases[decodeURIComponent(b.dataset.alias)];persist();renderAliases()})}
function refresh(){bookOptions();renderDashboard();renderHistory();renderCompare();renderAliases();window.learningRefreshPredictions?.()}
function download(filename,content,mime){const blob=new Blob([content],{type:mime});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function csvCell(v){return '"'+String(v??'').replaceAll('"','""')+'"'}
function handleImages(files){pendingImages.push(...Array.from(files));if(window.receiptQueueChanged)window.receiptQueueChanged();else $('imageQueue').textContent=pendingImages.length+'枚選択しました。'}
function init(){installDatePickerWholeField();chartPrefsRead();$('foodScope').onchange=()=>{foodDrillSub=null;renderDashboard()};$('foodBack').onclick=()=>{foodDrillSub=null;renderDashboard()};$('chartBarButton').onclick=()=>setChartView('bar');$('chartPieButton').onclick=()=>setChartView('pie');$('pieCategoryLevel').onchange=()=>{try{localStorage.setItem(DASHBOARD_PIE_LEVEL_KEY,$('pieCategoryLevel').value)}catch{}renderDashboard()};if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(()=>{});$('month').value=today().slice(0,7);$('purchaseDate').value=today();addRow();refresh();document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.id===b.dataset.tab));refresh()});$('book').onchange=e=>{if(window.cloudMode){e.target.value=state.activeBook;return;}state.activeBook=e.target.value;persist();refresh()};$('addBook').onclick=()=>{if(window.cloudMode)return toast('共有家計簿の作成は今後対応します');const name=prompt('新しい家計簿名（この端末内での切り替え）');if(!name?.trim())return;const id=uid();state.books.push({id,name:name.trim(),kind:'shared'});state.activeBook=id;persist();refresh()};$('month').onchange=renderDashboard;$('accountingMode').onchange=renderDashboard;$('purchaseDate').addEventListener('change',()=>{document.querySelectorAll('.item-row .account-month').forEach(el=>{if(el.dataset.changed!=='yes')el.value=$('purchaseDate').value.slice(0,7)})});document.addEventListener('change',e=>{if(e.target?.matches('.item-row .account-month'))e.target.dataset.changed='yes'});$('addItem').onclick=()=>addRow();$('savePurchase').onclick=savePurchase;$('historySearch').oninput=renderHistory;$('historyMode').onchange=renderHistory;['compareSearch','period','fromDate','toDate','originFilter','stateFilter'].forEach(id=>$(id).addEventListener('input',()=>{const custom=$('period').value==='custom';$('fromDate').hidden=!custom;$('toDate').hidden=!custom;renderCompare()}));$('camera').onchange=e=>handleImages(e.target.files);$('images').onchange=e=>handleImages(e.target.files);$('exportJson').onclick=()=>download('receipt-backup-'+today()+'.json',JSON.stringify({...state,learnedRules:window.learningExportRules?.()||state.learnedRules||[]},null,2),'application/json');$('exportCsv').onclick=()=>{const cols=['家計簿','購入日','店舗','商品名','統一商品名','商品全額','計上月','月別計上金額','月別配分数量','数量単位','購入数量','容量','大分類','小分類','産地','状態'];const lines=[cols,...state.purchases.flatMap(p=>p.items.flatMap(i=>accountingAllocations(p,i).map(a=>[state.books.find(b=>b.id===p.bookId)?.name,p.date,p.merchant,i.name,i.canonical,i.amount,a.month,a.amount,a.quantity,i.unit,i.qty,i.size,i.category,i.subcategory,i.origin,i.state])))];download('receipt-allocations-'+today()+'.csv','\ufeff'+lines.map(r=>r.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8')};$('importJson').onchange=async e=>{if(window.cloudMode){toast('ログアウト後に端末内バックアップを復元してください');e.target.value='';return;}const file=e.target.files?.[0];if(!file)return;try{const incoming=JSON.parse(await file.text());if(incoming.schemaVersion!==1||!Array.isArray(incoming.books)||!Array.isArray(incoming.purchases)||!incoming.books.every(b=>typeof b.id==='string')||!incoming.purchases.every(p=>Array.isArray(p.items)))throw Error('対応していないバックアップ形式です');if(!confirm('現在の端末内データをバックアップ内容で置き換えます。続行しますか？'))return;state=incoming;state.learnedRules||=[];persist();refresh();window.learningOnSignOut?.();toast('バックアップを復元しました')}catch(err){toast(err.message)}finally{e.target.value=''}};$('addAlias').onclick=()=>{const k=$('aliasRaw').value.trim(),v=$('aliasCanonical').value.trim();if(!k||!v)return toast('両方の商品名を入力してください');state.aliases[k]=v;persist();$('aliasRaw').value='';$('aliasCanonical').value='';renderAliases();toast('統一ルールを追加しました（既存履歴は変更しません）')}}
init();
