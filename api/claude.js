/* ============================================================
   Vercル サーバー関数：Anthropic(Claude) API のプロキシ
   ・APIキーは Vercel の環境変数 ANTHROPIC_API_KEY に保管し、
     ブラウザには一切出しません。
   ・ブラウザからは /api/claude に「messagesのbody」をPOSTするだけ。
   （設定：Vercel → プロジェクト → Settings → Environment Variables で
     ANTHROPIC_API_KEY を追加）
   ============================================================ */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY が未設定です（Vercelの環境変数を確認）" });
    return;
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
