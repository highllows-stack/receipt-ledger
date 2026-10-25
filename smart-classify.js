'use strict';
/*
 * Free on-device category inference (v1.0).
 * Existing Supabase learning rules are read, never changed by prediction.
 * No additional network calls, tracking, model downloads or paid AI.
 */
(function () {
  const WORDS = [
    // Food ingredients
    ['食材','米・麺類',[
      [/無洗米|ムセンマイ|むせんまい|精米|玄米|白米|もち米|もちごめ|新米|コシヒカリ|こしひかり|あきたこまち|ななつぼし|ひとめぼれ|ゆめぴりか|ササニシキ|つや姫|ライス米/,8,'米・品種名'],
      [/アカフジ|あかふじ/,4.5,'アカフジ'],[/ムセン(?!キ|LAN|ルーター)/,3.5,'ムセン（無洗米の略称候補）'],
      [/(?:^|[^ァ-ン])(?:お米|コメ|米)(?!ダ)|(?:お米|コメ|米)\d+(?:kg|キロ)|米穀/,6.8,'米・コメ'],
      [/パスタ|スパゲ(?:ティ|ッティ)|そうめん|素麺|うどん|そば|ラーメン用生麺|やきそば|ヤキソバ/,7,'麺類']]],
    ['食材','肉類',[
      [/豚肉|豚こま|豚バラ|豚ロース|牛肉|牛バラ|牛ロース|鶏肉|鶏もも|鶏むね|鶏胸|ひき肉|挽肉/,8,'肉の種類'],
      [/ワカドリ|若鶏|ブラジル鶏|トリモモ|トリムネ|チキンもも/,6.5,'鶏肉の表記'],
      [/モモニク|ムネニク|バラニク|ロースニク|ミンチ/,5.8,'肉の部位'],
      [/モモ|ムネ|バラ|ロース/,1.6,'部位らしい語']]],
    ['食材','魚介類',[
      [/鮭|サケ|サーモン|サバ|鯖|アジ|鯵|イワシ|鰯|マグロ|鮪|カツオ|鰹|ブリ|鰤|タイ|鯛|ホッケ|しらす|シラス|ホタテ|帆立|エビ|海老|イカ|タコ|あさり|アサリ/,7,'魚介類の名称']]],
    ['食材','野菜',[
      [/ブロッコリー|キャベツ|レタス|トマト|きゅうり|キュウリ|白菜|ハクサイ|にんじん|人参|ニンジン|たまねぎ|玉ねぎ|タマネギ|ピーマン|パプリカ|ほうれん草|ホウレンソウ|小松菜|コマツナ|じゃがいも|ジャガイモ|なす|ナス|大根|ダイコン|もやし|モヤシ|ごぼう|ゴボウ|ねぎ|ネギ/,7.5,'野菜名']]],
    ['食材','果物',[
      [/りんご|リンゴ|林檎|バナナ|みかん|ミカン|いちご|イチゴ|苺|ぶどう|ブドウ|葡萄|キウイ|パイナップル|桃|モモ果実|梨|ナシ|柿|カキ果実|オレンジ|グレープフルーツ/,7,'果物名']]],
    ['食材','卵・乳製品',[
      [/牛乳|ギュウニュウ|ぎゅうにゅう|低脂肪乳|成分無調整乳|飲用乳|たまご|タマゴ|鶏卵|生卵|チーズ|バター/,7.5,'卵・乳製品名']]],
    ['食材','豆製品',[
      [/豆腐|トウフ|とうふ|納豆|ナットウ|油揚げ|厚揚げ|おから|豆乳|トウニュウ/,7.5,'豆製品名']]],
    // Food pantry and ready-to-eat
    ['調味料','基本調味料',[
      [/しょうゆ|醤油|ショウユ|こいくち|コイグチ|うすくち|ウスクチ|みりん|ミリン|味噌|みそ|ミソ|砂糖|サトウ|食塩|お塩|酢(?!飯)|穀物酢|お酢|ぽん酢|ポン酢|ケチャップ|マヨネーズ/,7.5,'調味料名'],
      [/キッコーマン/,2.5,'調味料メーカー（補助情報）']]],
    ['調味料','油・ドレッシング',[
      [/サラダ油|ごま油|ゴマ油|オリーブオイル|キャノーラ油|こめ油|米油|ドレッシング|ドレッシン/,8,'食用油・ドレッシング']]],
    ['調味料','香辛料',[
      [/こしょう|コショウ|胡椒|ブラックペッパー|七味|一味|唐辛子|トウガラシ|シナモン|クミン|カレー粉/,7.5,'香辛料名']]],
    ['調味料','料理の素',[
      [/うちのごはん|ウチノゴハン|クックドゥ|Cook\s*Do|Ｃｏｏｋ\s*Ｄｏ|料理の素|おかずの素|鍋の素|炊き込み(?:ご飯|御飯)の素|シーズニング/,12,'料理の素・シリーズ名'],
      [/(?:麻婆|マーボー)(?:豆腐|茄子|なす)の素|(?:回鍋肉|ホイコーロー|青椒肉絲|チンジャオロース|酢豚|エビチリ)の素/,12,'料理の素の商品名']]],
    ['食品・飲料','冷凍食品',[
      [/冷凍餃子|冷凍ギョウザ|レイトウギョウザ|冷凍チャーハン|冷凍ピザ|冷凍からあげ|冷凍唐揚げ|冷凍弁当/,8,'冷凍の加工食品']]],
    ['食品・飲料','惣菜・弁当',[
      [/お弁当|ベントウ|惣菜|ソウザイ|幕の内|唐揚げ弁当|からあげ弁当|おにぎり|オニギリ|寿司盛合せ|コロッケ惣菜/,7.5,'惣菜・弁当']]],
    ['食品・飲料','インスタント食品',[
      [/カップヌードル|カップめん|カップ麺|即席麺|インスタントラーメン|レトルトカレー|レトルト|フリーズドライ/,7.5,'即席・レトルト食品']]],
    ['食品・飲料','デザート・ヨーグルト',[
      [/ヨーグルト|ヨーグル|プリン|ゼリー|杏仁豆腐|ババロア|ムース|デザート|アイスクリーム|アイスミルク/,9,'デザート・ヨーグルト名']]],
    ['食品・飲料','おやつ・間食',[
      [/おやつ|オヤツ|間食|カンショク|ポテトチップス|チョコレート|クッキー|ビスケット|グミ|キャンディ|キャンデー|スナック菓子|せんべい|煎餅|駄菓子/,9,'おやつ・間食名']]],
    ['食品・飲料','菓子',[
      [/ポテトチップス|チョコレート|チョコ菓子|クッキー|ビスケット|グミ|キャンディ|キャンデー|スナック菓子/,7,'菓子名']]],
    ['食品・飲料','飲料',[
      [/天然水|ミネラルウォーター|ペットボトル水|炭酸水|コーラ|コーヒー|珈琲|紅茶|麦茶|緑茶|ウーロン茶|スポーツドリンク|野菜ジュース|オレンジジュース|飲料水/,7,'飲料名']]],
    // 外食の店名・サービス名が明確なときだけ自動提案。食品名だけで外食と決めつけない。
    ['外食','ファストフード',[
      [/マクドナルド|マックデリバリー|モスバーガー|バーガーキング|ケンタッキー|KFC|フレッシュネスバーガー/,11,'ファストフード店名']]],
    ['外食','カフェ・喫茶',[
      [/スターバックス|スタバ|ドトール|タリーズ|コメダ珈琲|サンマルクカフェ/,11,'カフェ店名']]],
    ['外食','麺類・ラーメン',[
      [/一蘭|一風堂|天下一品|日高屋|幸楽苑|魂心家|ラーメン店/,11,'ラーメン店名']]],
    ['外食','レストラン',[
      [/サイゼリヤ|ガスト|デニーズ|ジョナサン|ココス|ロイヤルホスト|大戸屋|やよい軒|すき家|松屋フーズ|吉野家/,11,'飲食店名']]],
    ['外食','テイクアウト',[
      [/持ち帰り注文|テイクアウト注文|デリバリーサービス|ウーバーイーツ|Uber\s*Eats|出前館/,11,'テイクアウト・配達サービス']]],
    // Daily goods
    ['日用品','キッチン用品',[
      [/(?:食洗機|ショクセンキ).*(?:洗剤|センザイ)|(?:洗剤|センザイ).*(?:食洗機|ショクセンキ)|食器洗い.*(?:洗剤|センザイ)|キッチンペーパー|ラップフィルム|クッキングシート|アルミホイル|スポンジ.*食器/,8,'台所用品・食器用洗剤'],
      [/食洗機|ショクセンキ/,2.8,'食洗機（用途情報）'],[/洗剤|センザイ/,2,'洗剤']]],
    ['日用品','洗剤',[
      [/洗濯洗剤|センタクセンザイ|洗濯用.*洗剤|液体洗剤|粉末洗剤|柔軟剤|ジュウナンザイ|アタック洗剤|トップ洗剤/,8,'洗濯用洗剤'],
      [/洗剤|センザイ/,4.7,'洗剤']]],
    ['日用品','掃除用品',[
      [/トイレクリーナー|風呂用洗剤|おふろ洗剤|掃除シート|クイックル|フローリングワイパー|カビキラー|掃除用洗剤|カビ取り剤/,8,'掃除用品名']]],
    ['日用品','衛生用品',[
      [/歯ブラシ|ハブラシ|歯磨き粉|ハミガキ|生理用ナプキン|マスク不織布|消毒液|せっけん|石鹸|ハンドソープ|シャンプー|ボディソープ/,7,'衛生用品名']]],
    ['日用品','消耗品',[
      [/ティッシュ|トイレットペーパー|ごみ袋|ゴミ袋|ポリ袋|電池単三|乾電池|綿棒/,7,'日用消耗品']]],
    ['家具・家電','家具',[
      [/本棚|書棚|ラック収納|ソファ|ダイニングテーブル|デスクチェア|椅子|チェア|ベッドフレーム/,7,'家具名']]],
    ['家具・家電','家電',[
      [/冷蔵庫|洗濯機本体|電子レンジ|掃除機本体|炊飯器|食洗機本体|食器洗い乾燥機|ドライヤー本体/,7.5,'家電名']]],
    ['家具・家電','PC・周辺機器',[
      [/マウス(?:有線|無線|ゲーミング|PC)?$|キーボード|SSD|HDD|モニター|USBハブ|ルーター|グラフィックボード|グラボ/,7,'PC機器名']]],
    ['家具・家電','インテリア',[
      [/カーテン|クッション|ラグマット|カーペット|照明器具|間接照明/,7,'インテリア名']]],
    ['衣類・美容','衣類',[
      [/Tシャツ|ワイシャツ|パーカー|ズボン|パンツ衣類|ソックス|靴下|下着|インナー衣類|スウェット/,7,'衣類名']]],
    ['衣類・美容','スキンケア',[
      [/化粧水|乳液|美容液|保湿クリーム|日焼け止め|クレンジング|洗顔フォーム/,7.5,'スキンケア用品']]],
    ['衣類・美容','ヘアケア',[
      [/ヘアワックス|ヘアオイル|トリートメント|育毛剤|ヘアスプレー/,7,'ヘアケア用品']]],
    ['その他','医薬品',[
      [/かぜ薬|風邪薬|胃腸薬|解熱鎮痛|絆創膏|ばんそうこう|湿布薬|目薬/,7.5,'一般用医薬品']]]
  ];
  const FOOD_PKG=/(?:^|[^0-9])(?:[1-9]|10|20)\s*(?:kg|キロ)(?![a-z])/i;
  const pkgRegex=/(\d+(?:\.\d+)?)\s*(kg|キロ|g|グラム|ml|ミリリットル|l|リットル)(?![a-z])/i;
  function normalizeText(raw) {
    return String(raw||'').normalize('NFKC').toUpperCase()
      .replace(/[\s\u3000・_,.、。*＊()（）\/\\‐―-]/g,'')
      .replace(/[ぁ-ゖ]/g,ch=>String.fromCharCode(ch.charCodeAt(0)+96));
  }
  function strippedKey(raw) {
    return normalizeText(raw).replace(/\d+(?:\.\d+)?(?:KG|キロ|G|グラム|ML|ミリリットル|L|リットル|個|枚|袋)/g,'')
      .replace(/\d+$/g,'').slice(0,120);
  }
  function packageFromName(raw){
    const m=String(raw||'').normalize('NFKC').match(pkgRegex);
    if(!m)return null;
    const size=Number(m[1]);
    if(!Number.isFinite(size)||size<=0||size>100000)return null;
    const u=m[2].toLowerCase(),unit=u==='kg'||u==='キロ'?'kg':u==='g'||u==='グラム'?'g':u==='ml'||u==='ミリリットル'?'ml':'L';
    return {size,unit};
  }
  function evidenceScores(raw) {
    const text=String(raw||'').normalize('NFKC');
    const ranked=[];
    for(const [major,minor,patterns] of WORDS){
      let score=0;const reasons=[];
      for(const [re,weight,reason] of patterns){
        if(re.test(text)){score+=weight;reasons.push(reason);}
      }
      if(score>0){
        if(major==='食材'&&minor==='米・麺類'&&FOOD_PKG.test(text)){score+=1;reasons.push('米の販売でよく使われるkg表記（補助）');}
        if(major==='食材'&&minor==='野菜'&&/冷凍|レイトウ/.test(text)){score+=0.6;reasons.push('冷凍の表記（補助）');}
        ranked.push({major,minor,score,reasons});
      }
    }
    return ranked.sort((a,b)=>b.score-a.score);
  }
  function editSimilarity(a,b){
    if(a===b)return 1;
    const n=a.length,m=b.length;
    if(n<5||m<5||Math.abs(n-m)>Math.ceil(Math.max(n,m)*0.2))return 0;
    let prev=Array.from({length:m+1},(_,i)=>i),next=[];
    for(let i=1;i<=n;i++){
      next=[i];for(let j=1;j<=m;j++)next[j]=Math.min(prev[j]+1,next[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=next;
    }
    return 1-prev[m]/Math.max(n,m);
  }
  function similarLearned(raw,lexical) {
    if(typeof learningRules==='undefined'||!learningRules.size)return null;
    const key=strippedKey(raw);if(key.length<5)return null;
    const matches=[];
    for(const rule of learningRules.values()){
      if(!learningValidateCategory(rule.major_category,rule.minor_category))continue;
      const target=strippedKey(rule.raw_name);
      const similarity=editSimilarity(key,target);
      if(similarity>=0.88)matches.push({rule,similarity});
    }
    matches.sort((a,b)=>b.similarity-a.similarity);
    if(!matches.length)return null;
    const best=matches[0],other=matches.find(x=>x.rule.major_category!==best.rule.major_category||x.rule.minor_category!==best.rule.minor_category);
    if(other&&best.similarity-other.similarity<0.07)return null;
    // Strong keywords contradicting an old correction must win.
    if(lexical&&lexical.score>=7&&(lexical.major!==best.rule.major_category||lexical.minor!==best.rule.minor_category))return null;
    return best;
  }
  function predict(raw){
    const text=String(raw||'').trim();
    const key=typeof learningKey==='function'?learningKey(text):normalizeText(text);
    const patterns=evidenceScores(text);
    const first=patterns[0]||null,second=patterns[1]||null;
    let result={raw:text,major:'その他',minor:'未分類',level:'low',label:'要確認',source:'none',
      reasons:['商品名だけでは分類を特定できません'],autoApply:false,matchedRule:null,package:packageFromName(text)};
    if(!text)return result;
    if(typeof learningRules!=='undefined'){
      const exact=learningRules.get(key);
      if(exact&&learningValidateCategory(exact.major_category,exact.minor_category))return {...result,
        major:exact.major_category,minor:exact.minor_category,level:'high',label:'確定ルール',source:'exact',
        reasons:['過去に本人が修正・学習した同じ商品名'],autoApply:true,matchedRule:exact};
    }
    if(typeof learningHistorySuggestion==='function'&&typeof learningAvailable!=='undefined'&&learningAvailable){
      const history=learningHistorySuggestion(text);
      if(history&&learningValidateCategory(history.major_category,history.minor_category))return {...result,
        major:history.major_category,minor:history.minor_category,level:'high',label:'履歴一致',source:'history',
        reasons:['過去に登録した同名商品の分類'],autoApply:true,matchedRule:history};
    }
    const fuzzy=similarLearned(text,first);
    if(fuzzy){const sim=Math.round(fuzzy.similarity*100);return {...result,
      major:fuzzy.rule.major_category,minor:fuzzy.rule.minor_category,
      level:fuzzy.similarity>=0.95?'high':'medium',label:fuzzy.similarity>=0.95?'類似学習':'類似候補',
      source:'similar',reasons:[`学習済み「${fuzzy.rule.raw_name}」に類似（文字列一致率の目安 ${sim}%）`],
      autoApply:fuzzy.similarity>=0.95,matchedRule:fuzzy.rule};}
    if(!first)return result;
    const margin=first.score-(second?.score||0);
    const conflicted=second&&margin<2.1;
    const strong=first.score>=6.5&&margin>=2.1;
    const medium=first.score>=4.5&&margin>=2.1;
    const inferredLevel=conflicted?'low':strong?'high':medium?'medium':'low';
    return {...result,major:first.major,minor:first.minor,source:'dictionary',level:inferredLevel,
      label:inferredLevel==='high'?'根拠が強い':inferredLevel==='medium'?'推測候補':'要確認',
      reasons:[...first.reasons,...(conflicted?[`「${second.major} → ${second.minor}」も候補のため要確認`]:[])],
      autoApply:inferredLevel==='high'||inferredLevel==='medium'};
  }
  window.smartPredictCategory=predict;
  window.smartPackageFromName=packageFromName;
  // The existing OCR pipeline calls this hook. Do not alter stored history automatically.
  window.learningApplyOCRItem=function(item){
    const p=predict(item.name);
    const next={...item,learningMatch:p.label,smartPrediction:p};
    if(p.autoApply){
      next.category=p.major;next.subcategory=p.minor;
      if(p.source==='exact'||p.source==='history'){
        next.name=p.matchedRule.preferred_name||next.name;
        next.canonical=p.matchedRule.canonical_name||next.canonical;
        next.origin=p.matchedRule.origin||next.origin;
        next.state=p.matchedRule.storage_type||next.state;
      }
      const pkg=p.package;
      if(pkg&&(!next.size||next.unit==='個')){next.size=pkg.size;next.unit=pkg.unit;}
    }
    return next;
  };
  function resultHTML(name){
    const p=predict(name);
    const status=p.autoApply?`自動分類：${esc(p.major)} → ${esc(p.minor)}`:
      p.source==='none'?'分類は保留（要確認）':`候補：${esc(p.major)} → ${esc(p.minor)}（自動確定せず）`;
    return `<strong>${status}</strong><span class="smart-level">判断：${esc(p.label)}</span>`+
      `<ul>${p.reasons.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`+
      (p.package?`<small>商品名から容量 ${esc(p.package.size)} ${esc(p.package.unit)} を検出しました（容量だけでは種類を確定しません）。</small>`:'')+
      '<small>これは統計・辞書による推測です。正しい分類を保証するものではありません。</small>';
  }
  window.smartShowPrediction=function(){
    const input=document.getElementById('smartPreviewName'),result=document.getElementById('smartPreviewResult');
    if(!input||!result)return;
    if(!input.value.trim()){result.textContent='商品名を入力してください。';return;}
    result.innerHTML=resultHTML(input.value);
  };
  const input=document.getElementById('smartPreviewName');
  const button=document.getElementById('smartPreviewBtn');
  if(button)button.addEventListener('click',window.smartShowPrediction);
  if(input)input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();window.smartShowPrediction();}});
})();
