// Supabase Edge Function: receipt-ocr
// 秘密キーは Supabase Edge Function Secrets から取得し、ブラウザに公開しません。
// 要件: ocr-setup.sql を先に実行し、GOOGLE_VISION_API_KEY Secret を登録。
const origin = 'https://highllows-stack.github.io';
const cors: Record<string,string> = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};
function json(status: number, body: Record<string,unknown>){
  return new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
}
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const visionKey = Deno.env.get('GOOGLE_VISION_API_KEY') ?? '';
function publicKey():string{
  try{
    const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
    if(typeof keys.default === 'string') return keys.default;
  }catch{ /* older projects use SUPABASE_ANON_KEY */ }
  return Deno.env.get('SUPABASE_ANON_KEY') ?? '';
}
Deno.serve(async (req: Request) => {
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  if(req.method!=='POST') return json(405,{error:'POSTを使用してください'});
  if(req.headers.get('Origin') && req.headers.get('Origin')!==origin) return json(403,{error:'許可されていないサイトからのアクセスです'});
  if(!supabaseUrl || !visionKey || !publicKey()) return json(500,{error:'サーバーの認証情報が未設定です'});
  const bearer = req.headers.get('Authorization') ?? '';
  if(!/^Bearer\s+\S+$/i.test(bearer)) return json(401,{error:'家計簿アプリにログインしてください'});
  try{
    // User JWTを実際にSupabase Authで検証。publishableキーだけでは利用不可。
    const me = await fetch(`${supabaseUrl}/auth/v1/user`,{
      headers:{apikey: publicKey(), Authorization: bearer}, signal:AbortSignal.timeout(12000),
    });
    if(!me.ok) return json(401,{error:'ログインの有効期限が切れました。再ログインしてください'});
    const user=await me.json();
    if(!user?.id) return json(401,{error:'利用者を確認できませんでした'});
    const length=Number(req.headers.get('Content-Length')||'0');
    if(length>7_500_000) return json(413,{error:'画像データが大きすぎます'});
    const payload=await req.json();
    const b64=payload?.imageBase64;
    const mime=payload?.mimeType;
    if(typeof b64!=='string'||!['image/jpeg','image/png','image/webp'].includes(mime)||
       b64.length<100 || b64.length>6_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64))
      return json(400,{error:'JPEG・PNG・WebP画像（約5MB以下）を指定してください'});
    // DBでアトミックにカウントしてからVisionに送信。枠を超えたらAPIを呼ばない。
    const quota = await fetch(`${supabaseUrl}/rest/v1/rpc/claim_receipt_ocr_quota`,{
      method:'POST',headers:{'Content-Type':'application/json',apikey:publicKey(),Authorization:bearer},
      body:'{}', signal:AbortSignal.timeout(10000),
    });
    if(!quota.ok) {
      console.error('OCR quota error',quota.status,await quota.text());
      return json(503,{error:'OCRの利用制限設定を確認してください。ocr-setup.sqlを実行しましたか？'});
    }
    if((await quota.json())!==true) return json(429,{error:'OCRの月間利用上限に達しました（個人100回、全体500回）。翌月まで読み取りを停止します'});
    const google=await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(visionKey)}`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({requests:[{image:{content:b64},features:[{type:'DOCUMENT_TEXT_DETECTION'}],imageContext:{languageHints:['ja','en']}}]}),
      signal:AbortSignal.timeout(25000),
    });
    const result=await google.json().catch(()=>({}));
    if(!google.ok||result?.responses?.[0]?.error){
      console.error('Vision failure',google.status,result?.error?.code||result?.responses?.[0]?.error?.code);
      return json(502,{error:'Google Cloud Visionで読み取りに失敗しました。APIキーの制限や請求先設定をご確認ください'});
    }
    const first=result?.responses?.[0]||{};
    const text=String(first?.fullTextAnnotation?.text||first?.textAnnotations?.[0]?.description||'').slice(0,30000);
    if(!text.trim())return json(422,{error:'文字を検出できませんでした。レシートを明るい場所で撮影してください'});
    // 画像・秘密鍵は保存しない。認識結果だけ呼び出し元に返す。
    return json(200,{text});
  }catch(e){
    console.error('OCR request failed',e instanceof Error?e.message:'unknown');
    return json(500,{error:'OCR処理に失敗しました。少し待ってから再試行してください'});
  }
});
